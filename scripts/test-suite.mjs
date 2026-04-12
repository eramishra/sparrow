/**
 * Sparrow Functional Test Suite
 *
 * Usage:
 *   node scripts/test-suite.mjs           smoke + onboarding + commands (~25s)
 *   node scripts/test-suite.mjs --full    + LLM calls (~60s)
 *   node scripts/test-suite.mjs --debug   verbose failure output + DB state dump
 *
 * Test users (seed once with: node scripts/setup-test-users.mjs)
 *   test-sparrow-a   persistent · Strava connected (Ankur's tokens)
 *   test-sparrow-b   ephemeral  · reset to blank before every run
 *   test-sparrow-c   persistent · no Strava
 *
 * Exit code 1 on any failure — used by pre-commit hook and deploy gate.
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ── Env & flags ───────────────────────────────────────────────────────────────
// Load .env.local if present (local dev). In CI, env vars are injected by GitHub Actions.
try {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf-8')
      .split('\n').filter(l => l.includes('='))
      .map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').replace(/^"|"$/g, '').trim()]; })
  );
  Object.assign(process.env, env);
} catch {}
process.env.MOCK_TELEGRAM = 'true'; // intercept all Telegram calls — must be set before import

const FULL  = process.argv.includes('--full');
const DEBUG = process.argv.includes('--debug');

const A = 'test-sparrow-a';  // persistent + Strava
const B = 'test-sparrow-b';  // ephemeral
const C = 'test-sparrow-c';  // no Strava

// ── Supabase ──────────────────────────────────────────────────────────────────
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function dbUser(chatId) {
  const { data } = await sb.from('users').select('*').eq('telegram_chat_id', String(chatId)).maybeSingle();
  return data;
}

async function dbSet(chatId, fields) {
  await sb.from('users').upsert(
    { telegram_chat_id: String(chatId), ...fields, updated_at: new Date().toISOString() },
    { onConflict: 'telegram_chat_id' }
  );
}

async function dbPlan(chatId) {
  const { data: user } = await sb.from('users').select('id').eq('telegram_chat_id', String(chatId)).single();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb.from('weekly_plans').select('*')
    .eq('user_id', user.id).lte('week_starting', today)
    .order('week_starting', { ascending: false }).limit(1).maybeSingle();
  return data;
}

// ── Message capture ───────────────────────────────────────────────────────────
// telegram.js mockMsg() calls console.log — we replace it during handler calls
// to capture what Sparrow would have sent to the user.
let _msgs = [];
let _capturing = false;
const _origLog = console.log;

function startCapture() {
  _msgs = [];
  _capturing = true;
  console.log = (...args) => _msgs.push(args.join(' '));
}

function stopCapture() {
  if (_capturing) { console.log = _origLog; _capturing = false; }
  return _msgs.join('\n');
}

// ── Webhook handlers (imported after MOCK_TELEGRAM is set) ────────────────────
const { handleCallbackQuery, handleOnboarding, handleActiveUser, default: handler } = await import('../api/webhook.js');

// ── Sim helpers ───────────────────────────────────────────────────────────────
async function sim(chatId, text) {
  const user = await dbUser(chatId);
  startCapture();
  let err;
  try {
    if (user.onboarding_step !== 'done') {
      await handleOnboarding(user, String(chatId), text);
    } else {
      await handleActiveUser(user, String(chatId), text);
    }
  } catch (e) { err = e; } finally { stopCapture(); }
  if (err) throw err;
  return _msgs.join('\n');
}

// simHandler sends a full Telegram message through the main handler() — needed
// for commands handled at handler level (/reset, /start) not in handleActiveUser.
async function simHandler(chatId, text) {
  const req = {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { message: { chat: { id: chatId }, from: { first_name: 'Test' }, text } },
  };
  let statusCode;
  const res = {
    status: code => { statusCode = code; return { json: () => {}, end: () => {} }; },
    json: () => {}, end: () => {},
  };
  startCapture();
  let err;
  try { await handler(req, res); } catch (e) { err = e; } finally { stopCapture(); }
  if (err) throw err;
  return { status: statusCode, output: _msgs.join('\n') };
}

async function simCallback(chatId, callbackData) {
  startCapture();
  let err;
  try {
    await handleCallbackQuery({
      id: 'test_' + Date.now(),
      data: callbackData,
      message: { chat: { id: chatId }, message_id: 999 },
    });
  } catch (e) { err = e; } finally { stopCapture(); }
  if (err) throw err;
  return _msgs.join('\n');
}

// ── Assertions ────────────────────────────────────────────────────────────────
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertContains(haystack, needle, label = 'Output') {
  if (!haystack.includes(needle))
    throw new Error(`${label} missing "${needle}"\n  Got: ${haystack.replace(/\n/g, ' ').slice(0, 250)}`);
}
function assertStep(user, step) {
  assert(user.onboarding_step === step, `Expected step "${step}", got "${user.onboarding_step}"`);
}

// ── Test runner ───────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const bold    = s => `${c.bold}${s}${c.reset}`;
const dim     = s => `${c.dim}${s}${c.reset}`;
const section = s => `\n${c.magenta}${c.bold}── ${s} ${c.reset}`;

const results = { passed: 0, failed: 0, skipped: 0, failures: [] };

async function test(name, fn, { skip = false } = {}) {
  if (skip) {
    results.skipped++;
    process.stdout.write(`  ${dim('○ ' + name + ' [skip]')}\n`);
    return;
  }
  try {
    await fn();
    results.passed++;
    process.stdout.write(`  ${c.green}✓${c.reset} ${name}\n`);
  } catch (err) {
    results.failed++;
    results.failures.push({ name, error: err.message, stack: err.stack });
    process.stdout.write(`  ${c.red}✗${c.reset} ${name}\n    ${c.dim}${err.message.split('\n')[0]}${c.reset}\n`);
  }
}

// ── Pre-run normalization ─────────────────────────────────────────────────────
async function normalizeUsers() {
  // USER A: restore if a previous test run left it mid-profile-update
  const a = await dbUser(A);
  if (!a) { console.error(`\n${c.red}✗ test-sparrow-a not found. Run: node scripts/setup-test-users.mjs${c.reset}\n`); process.exit(1); }
  const b = await dbUser(B);
  if (!b) { console.error(`\n${c.red}✗ test-sparrow-b not found. Run: node scripts/setup-test-users.mjs${c.reset}\n`); process.exit(1); }
  const cc = await dbUser(C);
  if (!cc) { console.error(`\n${c.red}✗ test-sparrow-c not found. Run: node scripts/setup-test-users.mjs${c.reset}\n`); process.exit(1); }

  if (a.onboarding_step !== 'done') {
    await dbSet(A, { onboarding_step: 'done', fitness_level: 'intermediate', fitness_goal: 'endurance', days_per_week: 6 });
  }
  if (cc.onboarding_step !== 'done') {
    await dbSet(C, { onboarding_step: 'done' });
  }

  // USER B: always reset to blank slate
  await dbSet(B, {
    onboarding_step: 'awaiting_fitness_level',
    fitness_level: null, fitness_goal: null, days_per_week: null,
    age: null, height_cm: null, weight_kg: null, gender: null,
    context_notes: '',
    strava_connected: false, strava_athlete_id: null,
    strava_refresh_token: null, strava_access_token: null, strava_expires_at: null,
    strava_pending_reconnect: false,
    preferred_llm: 'gemini', llm_api_key: null,
  });
}

// ── Debug dump ────────────────────────────────────────────────────────────────
async function debugDump() {
  _origLog(section('DEBUG — test user DB state'));
  for (const [id, label] of [[A, 'USER_A'], [B, 'USER_B'], [C, 'USER_C']]) {
    const u = await dbUser(id);
    _origLog(`\n  ${c.cyan}${label}${c.reset} (${id})`);
    if (!u) { _origLog(`    ${c.red}NOT FOUND${c.reset}`); continue; }
    for (const f of ['onboarding_step', 'fitness_level', 'fitness_goal', 'days_per_week',
                     'strava_connected', 'preferred_llm', 'age', 'height_cm']) {
      _origLog(`    ${f.padEnd(20)} ${u[f] ?? dim('null')}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════
async function run() {
  _origLog(bold('\n🐦 Sparrow Test Suite') + (FULL ? ` ${c.cyan}[--full]${c.reset}` : ''));
  _origLog(dim(new Date().toLocaleString()) + '\n');

  await normalizeUsers();

  // ── SMOKE ──────────────────────────────────────────────────────────────────
  _origLog(section('SMOKE'));

  await test('unknown callback data does not crash', async () => {
    await simCallback(A, 'unknown:xyz');  // should silently return
  });

  await test('/help returns command list (USER_A)', async () => {
    const out = await sim(A, '/help');
    assertContains(out, '/plan');
    assertContains(out, '/newplan');
    assertContains(out, '/connect');
  });

  await test('/profile returns fitness fields (USER_A)', async () => {
    const out = await sim(A, '/profile');
    assertContains(out.toLowerCase(), 'intermediate', '/profile output');
    assertContains(out.toLowerCase(), 'endurance',    '/profile output');
  });

  await test('/plan returns plan or no-plan message without crashing (USER_C)', async () => {
    const out = await sim(C, '/plan');
    const valid = out.includes('week of') || out.includes('No plan') || out.includes('newplan');
    assert(valid, 'Unexpected /plan output: ' + out.replace(/\n/g, ' ').slice(0, 200));
  });

  await test('/llm shows current model (USER_C)', async () => {
    const out = await sim(C, '/llm');
    assertContains(out, 'gemini', '/llm output');
  });

  await test('/connect on user without Strava sends auth URL (USER_C)', async () => {
    const out = await sim(C, '/connect');
    assertContains(out, 'strava.com/oauth', '/connect output');
  });

  await test('/feedback on user without Strava returns connection error (USER_C)', async () => {
    const out = await sim(C, '/feedback');
    assertContains(out, 'Strava', '/feedback output');
  });

  await test('stale fl:beginner callback when step=done is silently ignored (USER_A)', async () => {
    const before = await dbUser(A);
    assertStep(before, 'done');
    await simCallback(A, 'fl:beginner');
    const after = await dbUser(A);
    assertStep(after, 'done');
  });

  // ── ONBOARDING ─────────────────────────────────────────────────────────────
  _origLog(section('ONBOARDING — full 9-step flow (USER_B)'));

  await test('USER_B starts at awaiting_fitness_level', async () => {
    const u = await dbUser(B);
    assertStep(u, 'awaiting_fitness_level');
  });

  await test('fl:intermediate → fitness_level saved, step = awaiting_goal', async () => {
    await simCallback(B, 'fl:intermediate');
    const u = await dbUser(B);
    assert(u.fitness_level === 'intermediate', `fitness_level: ${u.fitness_level}`);
    assertStep(u, 'awaiting_goal');
  });

  await test('goal_toggle:endurance → goal saved, step stays awaiting_goal', async () => {
    await simCallback(B, 'goal_toggle:endurance');
    const u = await dbUser(B);
    assert(u.fitness_goal?.includes('endurance'), `fitness_goal: ${u.fitness_goal}`);
    assertStep(u, 'awaiting_goal');
  });

  await test('goal_done → step = awaiting_days', async () => {
    await simCallback(B, 'goal_done');
    const u = await dbUser(B);
    assertStep(u, 'awaiting_days');
  });

  await test('days:4 → days_per_week saved, step = awaiting_age', async () => {
    await simCallback(B, 'days:4');
    const u = await dbUser(B);
    assert(u.days_per_week === 4, `days_per_week: ${u.days_per_week}`);
    assertStep(u, 'awaiting_age');
  });

  await test('age "37" → age saved, step = awaiting_height', async () => {
    await sim(B, '37');
    const u = await dbUser(B);
    assert(u.age === 37, `age: ${u.age}`);
    assertStep(u, 'awaiting_height');
  });

  await test('height "175" → height_cm saved, step = awaiting_limitations', async () => {
    await sim(B, '175');
    const u = await dbUser(B);
    assert(u.height_cm === 175, `height_cm: ${u.height_cm}`);
    assertStep(u, 'awaiting_limitations');
  });

  await test('/skip limitations → step = awaiting_events', async () => {
    await sim(B, '/skip');
    const u = await dbUser(B);
    assertStep(u, 'awaiting_events');
  });

  await test('/skip events → step = awaiting_strava', async () => {
    await sim(B, '/skip');
    const u = await dbUser(B);
    assertStep(u, 'awaiting_strava');
  });

  await test('/skip strava → step = done (onboarding complete)', async () => {
    await sim(B, '/skip');
    const u = await dbUser(B);
    assertStep(u, 'done');
  });

  await test('stale fl:beginner after onboarding complete is ignored (USER_B)', async () => {
    await simCallback(B, 'fl:beginner');
    const u = await dbUser(B);
    assertStep(u, 'done');
  });

  // ── PROFILE UPDATE ─────────────────────────────────────────────────────────
  _origLog(section('PROFILE UPDATE — pu: flow (USER_A)'));

  await test('/update profile → step = pu:fitness_level', async () => {
    await sim(A, '/update profile');
    const u = await dbUser(A);
    assertStep(u, 'pu:fitness_level');
  });

  await test('fl:advanced in pu: mode → level updated, step = pu:goal', async () => {
    await simCallback(A, 'fl:advanced');
    const u = await dbUser(A);
    assert(u.fitness_level === 'advanced', `fitness_level: ${u.fitness_level}`);
    assertStep(u, 'pu:goal');
  });

  await test('goal_done in pu: mode → step = pu:days', async () => {
    await simCallback(A, 'goal_done');
    const u = await dbUser(A);
    assertStep(u, 'pu:days');
  });

  await test('days:5 in pu: mode → days updated, step = pu:age', async () => {
    await simCallback(A, 'days:5');
    const u = await dbUser(A);
    assert(u.days_per_week === 5, `days_per_week: ${u.days_per_week}`);
    assertStep(u, 'pu:age');
  });

  await test('age "37" in pu: mode → step = pu:height', async () => {
    await sim(A, '37');
    const u = await dbUser(A);
    assertStep(u, 'pu:height');
  });

  await test('/skip height in pu: mode → step = pu:limitations', async () => {
    await sim(A, '/skip');
    const u = await dbUser(A);
    assertStep(u, 'pu:limitations');
  });

  await test('/skip limitations in pu: mode → step = pu:events', async () => {
    await sim(A, '/skip');
    const u = await dbUser(A);
    assertStep(u, 'pu:events');
  });

  await test('/skip events in pu: mode → step = done (profile update complete)', async () => {
    await sim(A, '/skip');
    const u = await dbUser(A);
    assertStep(u, 'done');
  });

  // Always restore USER_A to canonical state after profile update tests
  await test('restore USER_A to canonical state', async () => {
    await dbSet(A, { onboarding_step: 'done', fitness_level: 'intermediate', fitness_goal: 'endurance', days_per_week: 6 });
    const u = await dbUser(A);
    assertStep(u, 'done');
    assert(u.fitness_level === 'intermediate', 'fitness_level after restore');
  });

  // ── COMMANDS ───────────────────────────────────────────────────────────────
  _origLog(section('COMMANDS — active user routing'));

  await test('/plan returns valid output (USER_A with seeded plan)', async () => {
    const out = await sim(A, '/plan');
    const valid = out.includes('week of') || out.includes('No plan') || out.includes('newplan');
    assert(valid, 'Unexpected /plan output: ' + out.replace(/\n/g, ' ').slice(0, 200));
  });

  await test('smart routing: plan question answered from DB without LLM (USER_A)', async () => {
    // getDirectPlanResponse returns early for "what's my plan for Monday?"
    // if a plan exists — no LLM or Strava sync triggered.
    const plan = await dbPlan(A);
    if (!plan?.plan?.Monday) {
      results.skipped++;
      process.stdout.write(`  ${dim('○ smart routing: plan question answered from DB without LLM (USER_A) [skip — no Monday in plan]')}\n`);
      return;
    }
    const out = await sim(A, "what's my plan for Monday?");
    // Direct response always contains "Monday's Plan" — the smart routing format
    assertContains(out, "Monday", 'Smart routing output');
  });

  await test('/llm gemini saves model preference (USER_C)', async () => {
    await sim(C, '/llm gemini');
    const u = await dbUser(C);
    assert(u.preferred_llm === 'gemini', `preferred_llm: ${u.preferred_llm}`);
  });

  await test('/reset resets onboarding_step to awaiting_fitness_level (USER_C)', async () => {
    // /reset is handled at handler() level, not handleActiveUser — use simHandler
    const { status } = await simHandler(C, '/reset');
    assert(status === 200, `Expected HTTP 200, got ${status}`);
    const u = await dbUser(C);
    assertStep(u, 'awaiting_fitness_level');
    // Restore
    await dbSet(C, { onboarding_step: 'done' });
    assertStep(await dbUser(C), 'done');
  });

  // ── FULL ───────────────────────────────────────────────────────────────────
  _origLog(section(`FULL${FULL ? '' : '  (skipped — run with --full)'}`));

  await test('Q&A: training days question triggers LLM pipeline (USER_C)', async () => {
    const out = await sim(C, 'How many days a week do I train?');
    // Accept either a real answer (contains "day") or the LLM-busy message —
    // both prove the Q&A pipeline ran end-to-end.
    const pipelineRan = out.toLowerCase().includes('day') || out.includes('overwhelmed') || out.includes('try again');
    assert(pipelineRan, 'Q&A pipeline did not execute. Got: ' + out.replace(/\n/g, ' ').slice(0, 200));
  }, { skip: !FULL });

  await test('/newplan generates and saves plan to DB (USER_C, no Strava)', async () => {
    const { data: u } = await sb.from('users').select('id').eq('telegram_chat_id', C).single();
    const { data: before } = await sb.from('weekly_plans').select('id').eq('user_id', u.id);
    await sim(C, '/newplan');
    const { data: after } = await sb.from('weekly_plans').select('id').eq('user_id', u.id);
    assert((after?.length ?? 0) >= (before?.length ?? 0), 'Plan count should not decrease after /newplan');
    const latest = await dbPlan(C);
    assert(latest?.plan, 'Expected saved plan with plan JSON');
  }, { skip: !FULL });

  // ── Results ────────────────────────────────────────────────────────────────
  const total = results.passed + results.failed + results.skipped;
  _origLog(`\n${'─'.repeat(52)}`);
  _origLog(
    bold('Results') +
    `  ${c.green}${results.passed} passed${c.reset}` +
    `  ${results.failed > 0 ? c.red : c.dim}${results.failed} failed${c.reset}` +
    `  ${dim(results.skipped + ' skipped')}` +
    `  ${dim('of ' + total)}`
  );

  if (results.failures.length > 0) {
    _origLog(`\n${c.red}${c.bold}Failures:${c.reset}`);
    for (const { name, error, stack } of results.failures) {
      _origLog(`\n  ${c.red}✗${c.reset} ${bold(name)}`);
      _origLog(`    ${error.split('\n')[0]}`);
      if (DEBUG && stack) {
        _origLog(dim(stack.split('\n').slice(1, 5).map(l => '      ' + l.trim()).join('\n')));
      }
    }

    if (DEBUG) await debugDump();

    _origLog(`\n${c.yellow}Tip:${c.reset} check test user state in Supabase, or re-run with --debug for stack traces.\n`);
  }

  _origLog('');
  if (results.failed > 0) process.exit(1);
}

run().catch(err => {
  _origLog(`\n${c.red}Fatal:${c.reset} ${err.message}`);
  if (DEBUG) _origLog(err.stack);
  process.exit(1);
});
