/**
 * Sparrow — seed functional test users in Supabase.
 * Run once (or re-run to reset to canonical state):
 *   node scripts/setup-test-users.mjs
 *
 * Creates / overwrites three reserved test users:
 *   test-sparrow-a  persistent · Strava connected (Ankur's tokens) · full profile
 *   test-sparrow-b  ephemeral  · blank slate (reset before every test run)
 *   test-sparrow-c  persistent · no Strava · full profile
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ── Env ───────────────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf-8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').replace(/^"|"$/g, '').trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// ── Fetch Ankur's Strava credentials ─────────────────────────────────────────
const { data: ankur, error: ankurErr } = await sb
  .from('users')
  .select('strava_refresh_token, strava_access_token, strava_expires_at, weight_kg, gender')
  .eq('telegram_chat_id', '8659046367')
  .single();

if (ankurErr || !ankur?.strava_refresh_token) {
  console.error('✗ Could not load Ankur\'s Strava tokens. Ensure his account is connected.');
  process.exit(1);
}

// ── Synthetic plan — seeded for USER_A and USER_C ────────────────────────────
// All 7 days so smart-routing tests always have a target day available
const SYNTHETIC_PLAN = {
  Monday:    { workout: 'Easy Run',          duration: '45 min', notes: 'Zone 2, conversational pace' },
  Tuesday:   { workout: 'Strength Training', duration: '60 min', notes: 'Full body compound lifts' },
  Wednesday: { workout: 'Rest',              duration: '—',      notes: 'Active recovery or complete rest' },
  Thursday:  { workout: 'Tempo Run',         duration: '40 min', notes: 'Comfortably hard, lactate threshold' },
  Friday:    { workout: 'Cross Training',    duration: '45 min', notes: 'Bike, swim, or yoga' },
  Saturday:  { workout: 'Long Run',          duration: '75 min', notes: 'Easy aerobic base building' },
  Sunday:    { workout: 'Rest',              duration: '—',      notes: 'Full rest day' },
};

function lastMonday() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sun
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

const now = new Date().toISOString();
const weekStarting = lastMonday();

// ── Upsert helpers ────────────────────────────────────────────────────────────
async function upsert(chatId, fields) {
  const { error } = await sb.from('users').upsert(
    { telegram_chat_id: chatId, ...fields, updated_at: now },
    { onConflict: 'telegram_chat_id' }
  );
  if (error) throw new Error(`upsert ${chatId}: ${error.message}`);
}

async function seedPlan(chatId) {
  const { data: user } = await sb.from('users').select('id').eq('telegram_chat_id', chatId).single();
  const { error } = await sb.from('weekly_plans').upsert(
    { user_id: user.id, week_starting: weekStarting, plan: SYNTHETIC_PLAN, generated_at: now },
    { onConflict: 'user_id,week_starting' }
  );
  if (error) throw new Error(`seedPlan ${chatId}: ${error.message}`);
}

// ── USER A — persistent, Strava connected ─────────────────────────────────────
// Uses Ankur's real refresh token so Strava API calls work.
// strava_athlete_id is a fake test value to avoid routing conflicts with Ankur.
await upsert('test-sparrow-a', {
  display_name:           'test-persistent-strava',
  onboarding_step:        'done',
  fitness_background:     'already_active',
  fitness_level:          'intermediate',
  fitness_goal:           'endurance',
  days_per_week:          6,
  age:                    37,
  height_cm:              180,
  weight_kg:              ankur.weight_kg,
  gender:                 ankur.gender,
  context_notes:          '- Injuries/limitations: None\n- Target/event: 10K race in June',
  preferred_llm:          'gemini',
  llm_api_key:            null,
  strava_connected:       true,
  strava_athlete_id:      'test-athlete-a',   // fake — avoids webhook routing conflicts
  strava_refresh_token:   ankur.strava_refresh_token,
  strava_access_token:    ankur.strava_access_token,
  strava_expires_at:      ankur.strava_expires_at,
  strava_pending_reconnect: false,
});
await seedPlan('test-sparrow-a');

// ── USER B — ephemeral, blank slate ───────────────────────────────────────────
// Reset to this state before every test run.
// Strava tokens are NOT pre-seeded; the onboarding flow test skips Strava via /skip.
await upsert('test-sparrow-b', {
  display_name:           'test-ephemeral',
  onboarding_step:        'awaiting_fitness_level',
  fitness_background:     null,
  fitness_level:          null,
  fitness_goal:           null,
  days_per_week:          null,
  age:                    null,
  height_cm:              null,
  weight_kg:              null,
  gender:                 null,
  context_notes:          '',
  preferred_llm:          'gemini',
  llm_api_key:            null,
  strava_connected:       false,
  strava_athlete_id:      null,
  strava_refresh_token:   null,
  strava_access_token:    null,
  strava_expires_at:      null,
  strava_pending_reconnect: false,
});

// ── USER C — persistent, no Strava ────────────────────────────────────────────
await upsert('test-sparrow-c', {
  display_name:           'test-no-strava',
  onboarding_step:        'done',
  fitness_background:     'new_to_fitness',
  fitness_level:          'beginner',
  fitness_goal:           'general',
  days_per_week:          3,
  age:                    28,
  height_cm:              165,
  weight_kg:              null,
  gender:                 null,
  context_notes:          '- Injuries/limitations: None\n- Target/event: Build a consistent habit',
  preferred_llm:          'gemini',
  llm_api_key:            null,
  strava_connected:       false,
  strava_athlete_id:      null,
  strava_refresh_token:   null,
  strava_access_token:    null,
  strava_expires_at:      null,
  strava_pending_reconnect: false,
});
await seedPlan('test-sparrow-c');

console.log('✓ Test users seeded (week_starting: ' + weekStarting + ')');
console.log('  test-sparrow-a  persistent · Strava connected · plan seeded');
console.log('  test-sparrow-b  ephemeral  · blank slate');
console.log('  test-sparrow-c  persistent · no Strava · plan seeded');
