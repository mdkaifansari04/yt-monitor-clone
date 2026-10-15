CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  handle TEXT,
  title TEXT NOT NULL,
  avatar_url TEXT,
  subscriber_count INTEGER,
  added_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  subs_checked_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  is_short INTEGER NOT NULL DEFAULT 0,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  thumb_hash TEXT,
  thumb_state TEXT NOT NULL DEFAULT 'stable',
  test_started_at INTEGER,
  thumb_checked_at INTEGER NOT NULL DEFAULT 0,
  watched_at INTEGER,
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX videos_channel ON videos(channel_id, published_at DESC);
CREATE INDEX videos_thumb_due ON videos(thumb_checked_at);

-- Every distinct thumbnail image ever served for a video, keyed by content hash.
CREATE TABLE thumbs (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  image BLOB NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (video_id, hash)
);

-- type: new_video | title_change | thumb_change | ab_test | ab_test_done | milestone
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  video_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX events_created ON events(created_at DESC);
CREATE UNIQUE INDEX events_one_upload ON events(video_id) WHERE type = 'new_video';

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
