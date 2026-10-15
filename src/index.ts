import { DAY, Env, num } from "./env";
import { applyFeed, knownVideos, refresh, Writes } from "./refresh";
import { apiChannelByHandle, type ChannelInfo, fetchChannelFeed, parseChannelInput, scrapeChannelPage } from "./youtube";

const EVENT_TYPES = ["new_video", "title_change", "thumb_change", "ab_test", "ab_test_done", "milestone"];

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function body<T>(req: Request): Promise<T> {
  try {
    return await req.json<T>();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

function list(v: string | null): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function getSettings(env: Env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { feedDays: num(map.feed_days, 3) };
}

async function feed(env: Env, url: URL) {
  const settings = await getSettings(env);
  const days = Math.min(num(url.searchParams.get("days") ?? undefined, settings.feedDays), num(env.RETENTION_DAYS, 60));
  const since = Date.now() - days * DAY;
  const types = list(url.searchParams.get("types")).filter((t) => EVENT_TYPES.includes(t));
  const channels = list(url.searchParams.get("channels"));
  const minViews = Number(url.searchParams.get("minViews") ?? 0) || 0;
  const hideWatched = url.searchParams.get("hideWatched") === "1";
  const shorts = url.searchParams.get("shorts") === "1";

  const where = ["e.created_at >= ?"];
  const params: unknown[] = [since];
  if (types.length) {
    where.push("e.type IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(types));
  }
  if (channels.length) {
    where.push("e.channel_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(channels));
  }
  if (!shorts) where.push("(v.id IS NULL OR v.is_short = 0)");
  if (hideWatched) where.push("NOT (e.type = 'new_video' AND v.watched_at IS NOT NULL)");
  if (minViews > 0) {
    where.push("(v.id IS NULL OR COALESCE(v.views, 0) >= ?)");
    params.push(minViews);
  }

  const { results } = await env.DB.prepare(
    `SELECT e.id, e.type, e.channel_id, e.video_id, e.data, e.created_at,
            c.title AS channel_title, c.avatar_url, c.handle, c.subscriber_count,
            v.title AS video_title, v.views, v.likes, v.comments, v.watched_at, v.is_short,
            v.published_at, v.thumb_state
     FROM events e
     JOIN channels c ON c.id = e.channel_id
     LEFT JOIN videos v ON v.id = e.video_id
     WHERE ${where.join(" AND ")}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 500`,
  )
    .bind(...params)
    .all<Record<string, unknown> & { data: string }>();

  const toWatch = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM videos v JOIN channels c ON c.id = v.channel_id
     WHERE v.published_at >= ? AND v.watched_at IS NULL AND v.is_short = 0`,
  )
    .bind(since)
    .first<{ n: number }>();

  return {
    days,
    toWatch: toWatch?.n ?? 0,
    events: results.map((r) => ({ ...r, data: JSON.parse(r.data || "{}") })),
  };
}

async function listChannels(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT c.*,
            (SELECT MAX(published_at) FROM videos v WHERE v.channel_id = c.id AND v.is_short = 0) AS last_upload_at,
            (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.is_short = 0 AND v.published_at > ?) AS uploads_30d
     FROM channels c ORDER BY c.title COLLATE NOCASE`,
  )
    .bind(Date.now() - 30 * DAY)
    .all();
  return { channels: results };
}

const FORCED_REFRESH_COOLDOWN_MS = 30_000;

/** Lets one manual refresh through per cooldown window, so the endpoint can't be hammered. */
async function claimForcedRefresh(env: Env) {
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('forced_refresh_at', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?2`,
  )
    .bind(String(now), now - FORCED_REFRESH_COOLDOWN_MS)
    .run();
  if (!r.meta.changes) throw new HttpError(429, "The feed was refreshed a moment ago — try again in a few seconds");
}

async function addChannel(env: Env, input: unknown) {
  if (typeof input !== "string" || !input.trim()) throw new HttpError(400, "Paste a @handle, channel URL or channel ID");
  let parsed: ReturnType<typeof parseChannelInput>;
  try {
    parsed = parseChannelInput(input);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }

  let info: ChannelInfo | null = null;
  if (env.YT_API_KEY && parsed.handle) info = await apiChannelByHandle(parsed.handle, env.YT_API_KEY).catch(() => null);
  if (!info) {
    try {
      info = await scrapeChannelPage(parsed.pageUrl);
    } catch (e) {
      if (!parsed.channelId) throw new HttpError(404, (e as Error).message);
    }
  }
  const channelId = info?.channelId ?? parsed.channelId!;

  const exists = await env.DB.prepare("SELECT title FROM channels WHERE id = ?").bind(channelId).first<{ title: string }>();
  if (exists) throw new HttpError(409, `You're already watching ${exists.title}`);

  let channelFeed;
  try {
    channelFeed = await fetchChannelFeed(channelId);
  } catch (e) {
    throw new HttpError(502, `Couldn't load uploads: ${(e as Error).message}`);
  }

  const now = Date.now();
  const w = new Writes(env.DB);
  w.run(
    `INSERT INTO channels (id, handle, title, avatar_url, subscriber_count, added_at, last_checked_at, subs_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    channelId,
    info?.handle ?? parsed.handle ?? null,
    info?.title || channelFeed.title,
    info?.avatarUrl ?? null,
    info?.subscribers ?? null,
    now,
    now,
    info ? now : 0,
  );
  channelFeed.channelId = channelId;
  applyFeed(w, channelFeed, await knownVideos(env.DB, channelFeed.videos.map((v) => v.id)), now);
  await w.flush();
  return { id: channelId, title: info?.title || channelFeed.title, videos: channelFeed.videos.length };
}

async function thumb(env: Env, videoId: string, hash: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT image, content_type FROM thumbs WHERE video_id = ? AND hash = ?")
    .bind(videoId, hash)
    .first<{ image: number[] | ArrayBuffer; content_type: string }>();
  if (!row) return new Response("Not found", { status: 404 });
  const bytes = row.image instanceof ArrayBuffer ? row.image : new Uint8Array(row.image);
  const contentType = /^image\/(jpeg|png|webp)$/.test(row.content_type) ? row.content_type : "image/jpeg";
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  let match: RegExpMatchArray | null;

  if (m === "GET" && path === "/api/feed") return json(await feed(env, url));
  if (m === "GET" && path === "/api/channels") return json(await listChannels(env));
  if (m === "POST" && path === "/api/channels") {
    const { input } = await body<{ input: unknown }>(req);
    return json(await addChannel(env, input), 201);
  }
  if (m === "DELETE" && (match = path.match(/^\/api\/channels\/(UC[\w-]{22})$/))) {
    await env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(match[1]).run();
    return json({ ok: true });
  }
  if (m === "POST" && (match = path.match(/^\/api\/videos\/([\w-]{11})\/watched$/))) {
    const { watched } = await body<{ watched: boolean }>(req);
    await env.DB.prepare("UPDATE videos SET watched_at = ? WHERE id = ?")
      .bind(watched ? Date.now() : null, match[1])
      .run();
    return json({ ok: true });
  }
  if (m === "POST" && path === "/api/videos/watch-all") {
    const { days } = await body<{ days: number }>(req);
    const r = await env.DB.prepare("UPDATE videos SET watched_at = ? WHERE watched_at IS NULL AND published_at >= ?")
      .bind(Date.now(), Date.now() - num(String(days), 3) * DAY)
      .run();
    return json({ ok: true, updated: r.meta.changes });
  }
  if (m === "GET" && (match = path.match(/^\/api\/thumb\/([\w-]{11})\/([0-9a-f]{8,64})$/))) {
    return thumb(env, match[1], match[2]);
  }
  if (m === "POST" && path === "/api/refresh") {
    await claimForcedRefresh(env);
    return json(await refresh(env, { force: true }));
  }
  if (m === "GET" && path === "/api/settings") {
    return json({
      ...(await getSettings(env)),
      apiKey: Boolean(env.YT_API_KEY),
      channelIntervalMin: num(env.CHANNEL_INTERVAL_MIN, 15),
      thumbIntervalMin: num(env.THUMB_INTERVAL_MIN, 60),
      thumbTrackDays: num(env.THUMB_TRACK_DAYS, 10),
      abSettleHours: num(env.AB_SETTLE_HOURS, 24),
      retentionDays: num(env.RETENTION_DAYS, 60),
    });
  }
  if (m === "PUT" && path === "/api/settings") {
    const { feedDays } = await body<{ feedDays: number }>(req);
    const days = Math.max(1, Math.min(Math.round(Number(feedDays)) || 3, num(env.RETENTION_DAYS, 60)));
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('feed_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(days))
      .run();
    return json(await getSettings(env));
  }
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    // Block cross-site writes (CSRF). Browsers always send Origin on these; curl etc. don't need it.
    const origin = req.headers.get("origin");
    if (req.method !== "GET" && req.method !== "HEAD" && origin && origin !== url.origin) {
      return json({ error: "Cross-origin requests aren't allowed" }, 403);
    }
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      // Don't leak D1/SQL internals to the client; the details are in the worker logs.
      return json({ error: "Something went wrong" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      refresh(env).then((s) => {
        if (s.errors.length) console.warn("refresh errors", s.errors);
        console.log("refresh", JSON.stringify({ ...s, errors: s.errors.length }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
