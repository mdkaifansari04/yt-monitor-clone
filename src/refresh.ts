import { DAY, Env, HOUR, MIN, num } from "./env";
import {
  apiChannels,
  apiVideoStats,
  type ChannelFeed,
  type ChannelInfo,
  fetchChannelFeed,
  sampleThumbnail,
  scrapeChannelPage,
  type ThumbSample,
} from "./youtube";

export interface RefreshSummary {
  channelsChecked: number;
  thumbnailsSampled: number;
  newEvents: number;
  errors: string[];
}

interface ChannelRow {
  id: string;
  title: string;
  handle: string | null;
  subscriber_count: number | null;
}

interface VideoThumbRow {
  id: string;
  channel_id: string;
  thumb_hash: string | null;
  thumb_state: "stable" | "testing";
  test_started_at: number | null;
}

interface ThumbMeta {
  video_id: string;
  hash: string;
  first_seen_at: number;
  last_seen_at: number;
}

/** Bundles statements so a whole refresh lands in one D1 batch. */
export class Writes {
  stmts: D1PreparedStatement[] = [];
  newEvents = 0;
  constructor(private db: D1Database) {}

  run(sql: string, ...params: unknown[]) {
    this.stmts.push(this.db.prepare(sql).bind(...params));
  }

  event(type: string, channelId: string, videoId: string | null, data: object, createdAt: number) {
    this.newEvents++;
    this.run(
      "INSERT OR IGNORE INTO events (type, channel_id, video_id, data, created_at) VALUES (?, ?, ?, ?, ?)",
      type,
      channelId,
      videoId,
      JSON.stringify(data),
      createdAt,
    );
  }

  async flush() {
    for (let i = 0; i < this.stmts.length; i += 80) await this.db.batch(this.stmts.slice(i, i + 80));
    this.stmts = [];
  }
}

/** Diffs an upload feed against what we already know: new uploads, title rewrites, stats. */
export function applyFeed(w: Writes, feed: ChannelFeed, known: Map<string, { title: string }>, now: number) {
  for (const v of feed.videos) {
    const prev = known.get(v.id);
    if (!prev) {
      w.run(
        `INSERT OR IGNORE INTO videos (id, channel_id, title, published_at, is_short, views, likes, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        v.id,
        feed.channelId,
        v.title,
        v.publishedAt,
        v.isShort ? 1 : 0,
        v.views,
        v.likes,
        now,
      );
      w.event("new_video", feed.channelId, v.id, { title: v.title }, v.publishedAt);
      continue;
    }
    if (prev.title !== v.title) {
      w.event("title_change", feed.channelId, v.id, { from: prev.title, to: v.title }, now);
    }
    w.run(
      "UPDATE videos SET title = ?, views = COALESCE(?, views), likes = COALESCE(?, likes) WHERE id = ?",
      v.title,
      v.views,
      v.likes,
      v.id,
    );
  }
}

export function applyChannelInfo(w: Writes, row: ChannelRow, info: ChannelInfo, now: number) {
  const prev = row.subscriber_count;
  const next = info.subscribers;
  if (prev != null && next != null && next > prev) {
    w.event("milestone", row.id, null, { from: prev, to: next }, now);
  }
  w.run(
    `UPDATE channels SET subscriber_count = COALESCE(?, subscriber_count), avatar_url = COALESCE(?, avatar_url),
       handle = COALESCE(handle, ?), subs_checked_at = ? WHERE id = ?`,
    next,
    info.avatarUrl,
    info.handle,
    now,
    row.id,
  );
}

export async function knownVideos(db: D1Database, ids: string[]): Promise<Map<string, { title: string }>> {
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare("SELECT id, title FROM videos WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ id: string; title: string }>();
  return new Map(results.map((r) => [r.id, r]));
}

export async function refresh(env: Env, opts: { force?: boolean } = {}): Promise<RefreshSummary> {
  const db = env.DB;
  const now = Date.now();
  const w = new Writes(db);
  const errors: string[] = [];

  const channelInterval = opts.force ? 0 : num(env.CHANNEL_INTERVAL_MIN, 15) * MIN;
  const maxChannels = num(env.MAX_CHANNEL_FETCHES, 10);

  // ---- 1. Upload feeds ----
  const { results: dueChannels } = await db
    .prepare(
      `SELECT id, title, handle, subscriber_count FROM channels
       WHERE last_checked_at <= ? ORDER BY last_checked_at ASC LIMIT ?`,
    )
    .bind(now - channelInterval, maxChannels)
    .all<ChannelRow>();

  const feeds = await Promise.allSettled(dueChannels.map((c) => fetchChannelFeed(c.id)));
  const okFeeds: ChannelFeed[] = [];
  feeds.forEach((r, i) => {
    const c = dueChannels[i];
    if (r.status === "fulfilled") {
      // Trust our own id over the feed's <yt:channelId>; a mismatch would fail the
      // videos FK and roll back the whole batch on every run.
      okFeeds.push({ ...r.value, channelId: c.id });
      w.run("UPDATE channels SET last_checked_at = ?, last_error = NULL, title = ? WHERE id = ?", now, r.value.title || c.title, c.id);
    } else {
      const msg = String(r.reason?.message ?? r.reason);
      errors.push(`${c.title}: ${msg}`);
      w.run("UPDATE channels SET last_checked_at = ?, last_error = ? WHERE id = ?", now, msg, c.id);
    }
  });

  const known = await knownVideos(db, okFeeds.flatMap((f) => f.videos.map((v) => v.id)));
  for (const feed of okFeeds) applyFeed(w, feed, known, now);

  // ---- 2. Subscriber counts ----
  if (env.YT_API_KEY) {
    try {
      const infos = await apiChannels(dueChannels.map((c) => c.id), env.YT_API_KEY);
      for (const c of dueChannels) {
        const info = infos.get(c.id);
        if (info) applyChannelInfo(w, c, info, now);
      }
      const recentIds = okFeeds.flatMap((f) => f.videos.filter((v) => v.publishedAt > now - 60 * DAY).map((v) => v.id));
      const stats = await apiVideoStats(recentIds, env.YT_API_KEY);
      for (const [id, s] of stats) {
        w.run(
          "UPDATE videos SET views = COALESCE(?, views), likes = COALESCE(?, likes), comments = COALESCE(?, comments) WHERE id = ?",
          s.views,
          s.likes,
          s.comments,
          id,
        );
      }
    } catch (e) {
      errors.push(`YouTube API: ${(e as Error).message}`);
    }
  } else {
    // Without an API key, scrape one channel page per run (they're ~1.5 MB each).
    const stale = await db
      .prepare(
        `SELECT id, title, handle, subscriber_count FROM channels
         WHERE subs_checked_at <= ? ORDER BY subs_checked_at ASC LIMIT 1`,
      )
      .bind(now - 6 * HOUR)
      .first<ChannelRow>();
    if (stale) {
      try {
        applyChannelInfo(w, stale, await scrapeChannelPage(`https://www.youtube.com/channel/${stale.id}`), now);
      } catch (e) {
        errors.push(`${stale.title} subscribers: ${(e as Error).message}`);
        w.run("UPDATE channels SET subs_checked_at = ? WHERE id = ?", now, stale.id);
      }
    }
  }

  // ---- 3. Thumbnails ----
  const sampled = await checkThumbnails(env, w, now);

  // ---- 4. Retention ----
  const retention = num(env.RETENTION_DAYS, 60) * DAY;
  w.run("DELETE FROM events WHERE created_at < ?", now - retention);
  w.run(
    "DELETE FROM thumbs WHERE video_id IN (SELECT id FROM videos WHERE published_at < ? AND thumb_state = 'stable')",
    now - retention,
  );

  await w.flush();
  return { channelsChecked: dueChannels.length, thumbnailsSampled: sampled, newEvents: w.newEvents, errors };
}

/**
 * Samples the thumbnail currently served for each due video and runs a small
 * state machine over the content hashes:
 *   stable  + a different hash only        -> thumbnail swap
 *   stable  + two hashes at once / old one back -> A/B test started
 *   testing + only one hash for AB_SETTLE_HOURS -> A/B test finished (winner)
 */
async function checkThumbnails(env: Env, w: Writes, now: number): Promise<number> {
  const db = env.DB;
  const interval = num(env.THUMB_INTERVAL_MIN, 60) * MIN;
  const trackFor = num(env.THUMB_TRACK_DAYS, 10) * DAY;
  const settle = num(env.AB_SETTLE_HOURS, 24) * HOUR;
  const budget = num(env.MAX_THUMB_FETCHES, 24);

  const { results: due } = await db
    .prepare(
      `SELECT id, channel_id, thumb_hash, thumb_state, test_started_at FROM videos
       WHERE is_short = 0 AND thumb_checked_at <= ?
         AND (published_at > ? OR (thumb_state = 'testing' AND published_at > ?))
       ORDER BY thumb_checked_at ASC LIMIT ?`,
    )
    .bind(now - interval, now - trackFor, now - 30 * DAY, Math.ceil(budget / 2))
    .all<VideoThumbRow>();
  if (!due.length) return 0;

  // New videos get an extra sample so a test running from upload is caught sooner.
  const plan: { video: VideoThumbRow; samples: number }[] = [];
  let left = budget;
  for (const video of due) {
    const samples = Math.min(left, video.thumb_hash ? 2 : 3);
    if (samples <= 0) break;
    plan.push({ video, samples });
    left -= samples;
  }

  const { results: metas } = await db
    .prepare(
      `SELECT video_id, hash, first_seen_at, last_seen_at FROM thumbs
       WHERE video_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(plan.map((p) => p.video.id)))
    .all<ThumbMeta>();

  const results = await Promise.all(
    plan.map(async ({ video, samples }) => {
      const got = await Promise.all(Array.from({ length: samples }, () => sampleThumbnail(video.id).catch(() => null)));
      return { video, got: got.filter((s): s is ThumbSample => s !== null) };
    }),
  );

  let sampledCount = 0;
  for (const { video, got } of results) {
    sampledCount += got.length;
    w.run("UPDATE videos SET thumb_checked_at = ? WHERE id = ?", now, video.id);
    if (!got.length) continue;

    const known = new Map(metas.filter((m) => m.video_id === video.id).map((m) => [m.hash, { ...m }]));
    const before = new Map([...known].map(([h, m]) => [h, { ...m }]));
    const seen = new Map<string, ThumbSample>();
    for (const s of got) seen.set(s.hash, s);

    for (const [hash, s] of seen) {
      const m = known.get(hash);
      if (m) {
        m.last_seen_at = now;
        w.run(
          "UPDATE thumbs SET last_seen_at = ?, seen_count = seen_count + 1 WHERE video_id = ? AND hash = ?",
          now,
          video.id,
          hash,
        );
      } else {
        known.set(hash, { video_id: video.id, hash, first_seen_at: now, last_seen_at: now });
        w.run(
          `INSERT OR IGNORE INTO thumbs (video_id, hash, image, content_type, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          video.id,
          hash,
          s.bytes,
          s.contentType,
          now,
          now,
        );
      }
    }

    const seenHashes = [...seen.keys()];
    const current = video.thumb_hash;

    const startTest = (variants: string[]) => {
      w.run("UPDATE videos SET thumb_state = 'testing', test_started_at = ? WHERE id = ?", now, video.id);
      // A "swap" we reported in the last two days was really the first rotation of this test.
      w.run(
        "DELETE FROM events WHERE video_id = ? AND type = 'thumb_change' AND created_at > ?",
        video.id,
        now - 2 * DAY,
      );
      w.event("ab_test", video.channel_id, video.id, { variants }, now);
    };

    if (!current) {
      if (seenHashes.length === 1) w.run("UPDATE videos SET thumb_hash = ? WHERE id = ?", seenHashes[0], video.id);
      else {
        w.run("UPDATE videos SET thumb_hash = ? WHERE id = ?", seenHashes[0], video.id);
        startTest(seenHashes);
      }
      continue;
    }

    if (video.thumb_state === "stable") {
      const others = seenHashes.filter((h) => h !== current);
      if (!others.length) continue;
      const returning = others.filter((h) => (before.get(h)?.last_seen_at ?? 0) > now - 2 * DAY);
      if (seenHashes.includes(current) || returning.length) {
        startTest([...new Set([current, ...seenHashes])]);
      } else {
        w.event("thumb_change", video.channel_id, video.id, { from: current, to: others[0] }, now);
        w.run("UPDATE videos SET thumb_hash = ? WHERE id = ?", others[0], video.id);
      }
      continue;
    }

    // testing
    const startedAt = video.test_started_at ?? now;
    const inTest = (m: Map<string, ThumbMeta>) =>
      [...m.values()].filter((t) => t.last_seen_at >= startedAt).sort((a, b) => a.first_seen_at - b.first_seen_at).map((t) => t.hash);
    const variants = inTest(known);
    if (variants.length > inTest(before).length) {
      w.run(
        `UPDATE events SET data = ? WHERE id = (
           SELECT id FROM events WHERE video_id = ? AND type = 'ab_test' ORDER BY id DESC LIMIT 1)`,
        JSON.stringify({ variants }),
        video.id,
      );
    }
    const recent = [...known.values()].filter((t) => t.last_seen_at > now - settle);
    if (now - startedAt >= settle && recent.length === 1) {
      const winner = recent[0].hash;
      w.event("ab_test_done", video.channel_id, video.id, { winner, variants }, now);
      w.run(
        "UPDATE videos SET thumb_state = 'stable', thumb_hash = ?, test_started_at = NULL WHERE id = ?",
        winner,
        video.id,
      );
    }
  }
  return sampledCount;
}
