-- Run this in your Supabase SQL editor to set up the database

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  onboarding_step TEXT NOT NULL DEFAULT 'awaiting_fitness_level',
  fitness_background TEXT,
  strava_connected BOOLEAN NOT NULL DEFAULT false,
  strava_athlete_id TEXT,
  strava_refresh_token TEXT,
  strava_access_token TEXT,
  strava_expires_at BIGINT,
  context_notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fitness_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strava_activity_id BIGINT NOT NULL,
  activity_date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  type TEXT,
  distance_km NUMERIC(8,2),
  duration_min INTEGER,
  avg_heart_rate NUMERIC(5,1),
  elevation_gain NUMERIC(8,1),
  name TEXT,
  UNIQUE(user_id, strava_activity_id)
);

CREATE TABLE weekly_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_starting DATE NOT NULL,
  plan JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, week_starting)
);

CREATE INDEX idx_activities_user_date ON fitness_activities(user_id, started_at DESC);
CREATE INDEX idx_plans_user ON weekly_plans(user_id, week_starting DESC);
