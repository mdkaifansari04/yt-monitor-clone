export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  YT_API_KEY?: string;
  CHANNEL_INTERVAL_MIN?: string;
  THUMB_INTERVAL_MIN?: string;
  THUMB_TRACK_DAYS?: string;
  AB_SETTLE_HOURS?: string;
  MAX_CHANNEL_FETCHES?: string;
  MAX_THUMB_FETCHES?: string;
  RETENTION_DAYS?: string;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
