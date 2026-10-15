// Everything that talks to YouTube. Public pages + RSS by default; the Data API
// is used only when a YT_API_KEY secret is configured (adds comment counts and
// exact-ish subscriber counts without scraping).

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const PAGE_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  // Skips the EU consent interstitial some Cloudflare colos would otherwise get.
  Cookie: "CONSENT=YES+cb; SOCS=CAI",
};

export interface FeedVideo {
  id: string;
  title: string;
  publishedAt: number;
  isShort: boolean;
  views: number | null;
  likes: number | null;
}

export interface ChannelFeed {
  channelId: string;
  title: string;
  videos: FeedVideo[];
}

export interface ChannelInfo {
  channelId: string;
  title: string | null;
  handle: string | null;
  avatarUrl: string | null;
  subscribers: number | null;
}

export interface VideoStats {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface ThumbSample {
  hash: string;
  bytes: ArrayBuffer;
  contentType: string;
}

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const VIDEO_ID_RE = /^[\w-]{11}$/;

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1].trim()) : null;
}

function attr(xml: string, name: string, attribute: string): string | null {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*?${attribute}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

function int(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function parseFeed(xml: string): ChannelFeed {
  const firstEntry = xml.indexOf("<entry>");
  const head = firstEntry === -1 ? xml : xml.slice(0, firstEntry);
  const rawId = tag(head, "yt:channelId") ?? "";
  const channelId = rawId.startsWith("UC") ? rawId : `UC${rawId}`;
  const videos: FeedVideo[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const id = tag(entry, "yt:videoId");
    // Ids end up in URLs and HTML attributes, so only accept the real shape.
    if (!id || !VIDEO_ID_RE.test(id)) continue;
    const link = attr(entry, "link", "href") ?? "";
    videos.push({
      id,
      title: tag(entry, "title") ?? "",
      publishedAt: Date.parse(tag(entry, "published") ?? "") || Date.now(),
      isShort: link.includes("/shorts/"),
      views: int(attr(entry, "media:statistics", "views")),
      likes: int(attr(entry, "media:starRating", "count")),
    });
  }
  return { channelId, title: tag(head, "title") ?? channelId, videos };
}

export async function fetchChannelFeed(channelId: string): Promise<ChannelFeed> {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Upload feed returned HTTP ${res.status}`);
  return parseFeed(await res.text());
}

/** Turns "@handle", a handle, a channel URL or a UC… id into something we can look up. */
export function parseChannelInput(input: string): { channelId?: string; handle?: string; pageUrl: string } {
  let s = input.trim();
  if (CHANNEL_ID_RE.test(s)) return { channelId: s, pageUrl: `https://www.youtube.com/channel/${s}` };
  if (/youtube\.com|youtu\.be/i.test(s)) {
    const url = new URL(s.startsWith("http") ? s : `https://${s}`);
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first === "channel" && second && CHANNEL_ID_RE.test(second)) {
      return { channelId: second, pageUrl: `https://www.youtube.com/channel/${second}` };
    }
    if (first?.startsWith("@")) s = decodeURIComponent(first);
    else if ((first === "c" || first === "user") && second) {
      return { pageUrl: `https://www.youtube.com/${first}/${second}` };
    } else if (first) s = first;
    else throw new Error("That URL doesn't point at a channel");
  }
  const handle = s.startsWith("@") ? s : `@${s}`;
  if (!/^@[\w.\-·]{2,100}$/u.test(handle)) throw new Error("That doesn't look like a channel handle");
  return { handle, pageUrl: `https://www.youtube.com/${handle}` };
}

function parseCount(num: string, unit: string | undefined): number {
  const n = parseFloat(num.replace(/,/g, ""));
  const mult = unit === "thousand" || unit === "K" ? 1e3 : unit === "million" || unit === "M" ? 1e6 : unit === "billion" || unit === "B" ? 1e9 : 1;
  return Math.round(n * mult);
}

/** Scrapes a channel page for its id, name, avatar and (rounded) subscriber count. */
export async function scrapeChannelPage(pageUrl: string): Promise<ChannelInfo> {
  let res = await fetch(pageUrl, { headers: PAGE_HEADERS });
  // YouTube occasionally rate-limits Cloudflare egress IPs; one retry usually lands elsewhere.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 800));
    res = await fetch(pageUrl, { headers: PAGE_HEADERS });
  }
  if (res.status === 404) throw new Error("Channel not found");
  if (res.status === 429) throw new Error("YouTube is rate-limiting channel lookups right now — try again in a minute");
  if (!res.ok) throw new Error(`Channel page returned HTTP ${res.status}`);
  const html = await res.text();

  const channelId =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
    html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  if (!channelId) throw new Error("Couldn't find a channel on that page");

  const header = html.indexOf('"pageHeaderViewModel"');
  const subsMatch = html
    .slice(header === -1 ? 0 : header)
    .match(/"accessibilityLabel":"([\d.,]+)\s*(thousand|million|billion)?\s*subscribers?"/);

  return {
    channelId,
    title: decodeXml(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "") || null,
    handle: html.match(/"vanityChannelUrl":"https?:\/\/www\.youtube\.com\/(@[^"]+)"/)?.[1] ?? null,
    avatarUrl: html.match(/<meta property="og:image" content="([^"]*)"/)?.[1]?.replace(/=s\d+-/, "=s176-") ?? null,
    subscribers: subsMatch ? parseCount(subsMatch[1], subsMatch[2]) : null,
  };
}

// ---- YouTube Data API (optional) ----

async function api<T>(path: string, params: Record<string, string>, key: string): Promise<T> {
  const qs = new URLSearchParams({ ...params, key });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`);
  if (!res.ok) throw new Error(`YouTube API ${path} returned HTTP ${res.status}`);
  return res.json<T>();
}

interface ApiChannel {
  id: string;
  snippet?: { title: string; customUrl?: string; thumbnails?: Record<string, { url: string }> };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
}

function toChannelInfo(c: ApiChannel): ChannelInfo {
  const thumbs = c.snippet?.thumbnails;
  return {
    channelId: c.id,
    title: c.snippet?.title ?? null,
    handle: c.snippet?.customUrl ?? null,
    avatarUrl: thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
    subscribers: c.statistics?.hiddenSubscriberCount ? null : int(c.statistics?.subscriberCount),
  };
}

export async function apiChannelByHandle(handle: string, key: string): Promise<ChannelInfo | null> {
  const r = await api<{ items?: ApiChannel[] }>("channels", { part: "snippet,statistics", forHandle: handle }, key);
  return r.items?.[0] ? toChannelInfo(r.items[0]) : null;
}

export async function apiChannels(ids: string[], key: string): Promise<Map<string, ChannelInfo>> {
  const out = new Map<string, ChannelInfo>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await api<{ items?: ApiChannel[] }>("channels", { part: "snippet,statistics", id: ids.slice(i, i + 50).join(",") }, key);
    for (const c of r.items ?? []) out.set(c.id, toChannelInfo(c));
  }
  return out;
}

export async function apiVideoStats(ids: string[], key: string): Promise<Map<string, VideoStats>> {
  const out = new Map<string, VideoStats>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await api<{ items?: { id: string; statistics?: Record<string, string> }[] }>(
      "videos",
      { part: "statistics", id: ids.slice(i, i + 50).join(",") },
      key,
    );
    for (const v of r.items ?? []) {
      out.set(v.id, {
        views: int(v.statistics?.viewCount),
        likes: int(v.statistics?.likeCount),
        comments: int(v.statistics?.commentCount),
      });
    }
  }
  return out;
}

// ---- Thumbnails ----

/**
 * Fetches the thumbnail YouTube is serving right now. A random query string and
 * no-store keep any cache between us and YouTube from pinning one variant.
 */
export async function sampleThumbnail(videoId: string): Promise<ThumbSample | null> {
  const bust = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg?_=${bust}`, {
    headers: { "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return null;
  const bytes = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hash, bytes, contentType };
}
