ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_pending_reconnect boolean DEFAULT false;
