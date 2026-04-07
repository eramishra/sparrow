/**
 * One-time script to register the Strava webhook subscription.
 *
 * Usage: node scripts/register-strava-webhook.mjs
 *
 * Run this once after deploying. Strava will immediately send a GET to
 * /api/strava-webhook to verify — make sure your app is deployed first.
 */

import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const [k, ...v] = l.split("=");
      return [k.trim(), v.join("=").replace(/^"|"$/g, "").trim()];
    })
);

const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_WEBHOOK_VERIFY_TOKEN, APP_URL } = env;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET || !STRAVA_WEBHOOK_VERIFY_TOKEN || !APP_URL) {
  console.error("Missing required env vars: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_WEBHOOK_VERIFY_TOKEN, APP_URL");
  process.exit(1);
}

const callbackUrl = `${APP_URL}/api/strava-webhook`;
console.log(`Registering webhook → ${callbackUrl}`);

const res = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    callback_url: callbackUrl,
    verify_token: STRAVA_WEBHOOK_VERIFY_TOKEN,
  }),
});

const data = await res.json();

if (!res.ok) {
  console.error("Registration failed:", JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log("✓ Webhook registered! Subscription ID:", data.id);
console.log("  Strava will now POST to your endpoint on every new activity.");
