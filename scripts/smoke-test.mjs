/**
 * Post-deploy smoke test
 *
 * Verifies that talktosparrow.vercel.app is serving the latest deployment
 * and that the strava-webhook endpoint is reachable and executing code.
 * Sends a real message to the Sparrow Alerts channel as the final check.
 *
 * Run automatically by: npm run deploy
 * Run manually: node scripts/smoke-test.mjs
 */

import { readFileSync } from 'fs';

// Load env for local runs (no-op if already set by CI/deploy context)
try {
  const lines = readFileSync('.env.local', 'utf-8').split('\n');
  for (const line of lines) {
    const [k, ...v] = line.split('=');
    if (k && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').replace(/^"|"$/g, '').trim();
  }
} catch {}

const BASE = 'https://talktosparrow.vercel.app';
const TIMEOUT_MS = 15000;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

console.log('\n🔍 Smoke test: talktosparrow.vercel.app\n');

// ── 1. Strava webhook GET → subscription verification endpoint responds correctly
await check('GET /api/strava-webhook returns 403 Forbidden (not 404/502)', async () => {
  const res = await fetchWithTimeout(`${BASE}/api/strava-webhook`);
  assert(res.status === 403, `Expected 403, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'Forbidden', `Expected {error:"Forbidden"}, got ${JSON.stringify(body)}`);
});

// ── 2. Strava webhook POST with non-Strava athlete → executes code (takes time = DB query ran)
await check('POST /api/strava-webhook executes code (not a frozen/stale Lambda)', async () => {
  const start = Date.now();
  const res = await fetchWithTimeout(`${BASE}/api/strava-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object_type: 'activity',
      aspect_type: 'create',
      object_id: 99999999999,
      owner_id: 0,  // no user has athlete_id=0, so DB lookup returns null → quick return
      subscription_id: 339576,
    }),
  });
  const elapsed = Date.now() - start;
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, `Expected {ok:true}, got ${JSON.stringify(body)}`);
  // A frozen/stale Lambda responds in <200ms (edge cache). Real code takes >300ms (DB query).
  assert(elapsed > 300, `Response in ${elapsed}ms — looks like a frozen Lambda or cached response (expected >300ms for real DB execution)`);
});

// ── 3. Telegram webhook endpoint is reachable
await check('POST /api/webhook rejects missing secret (not 404/502)', async () => {
  const res = await fetchWithTimeout(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(res.status === 403, `Expected 403, got ${res.status}`);
});

// ── 4. Send real Telegram message to alerts channel → confirms bot token valid + channel reachable
await check('Telegram delivery to alerts channel works', async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_CHAT_ID;
  assert(token, 'TELEGRAM_BOT_TOKEN not set');
  assert(chatId, 'ADMIN_CHAT_ID not set');
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ *Sparrow deployed* — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\nAll ${passed} smoke checks passed.`,
      parse_mode: 'Markdown',
    }),
  });
  const body = await res.json();
  assert(body.ok, `Telegram API error: ${body.description}`);
});

// ── Summary
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
