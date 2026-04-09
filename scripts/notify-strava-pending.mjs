/**
 * One-time script to notify users who couldn't connect Strava due to app approval restrictions.
 *
 * Run this AFTER Strava approves your app for "All Athletes" access:
 *   node scripts/notify-strava-pending.mjs
 *
 * It will:
 *   1. Fetch all users with strava_pending_reconnect = true
 *   2. Send each a Telegram message prompting them to reconnect
 *   3. Clear the strava_pending_reconnect flag so they aren't re-notified
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const APP_URL = "https://talktosparrow.vercel.app";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const [k, ...v] = l.split("=");
      return [k.trim(), v.join("=").replace(/^"|"$/g, "").trim()];
    })
);

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN, STRAVA_CLIENT_ID } = env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !STRAVA_CLIENT_ID) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN, STRAVA_CLIENT_ID");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function sendTelegram(chatId, text, stravaUrl) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "Connect Strava", url: stravaUrl }]],
    },
  };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telegram error for chat_id=${chatId}: ${await res.text()}`);
}

function buildStravaUrl(chatId, stravaClientId) {
  const params = new URLSearchParams({
    client_id: stravaClientId,
    response_type: "code",
    redirect_uri: `${APP_URL}/api/strava-callback`,
    scope: "activity:read_all",
    approval_prompt: "force",
    state: String(chatId),
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

const { data: users, error } = await supabase
  .from("users")
  .select("telegram_chat_id, first_name")
  .eq("strava_pending_reconnect", true);

if (error) {
  console.error("Failed to fetch pending users:", error.message);
  process.exit(1);
}

if (!users.length) {
  console.log("No users pending Strava reconnect.");
  process.exit(0);
}

console.log(`Notifying ${users.length} user(s)...`);

for (const user of users) {
  const name = user.first_name ? ` ${user.first_name}` : "";
  try {
    const stravaUrl = buildStravaUrl(user.telegram_chat_id, STRAVA_CLIENT_ID);
    await sendTelegram(
      user.telegram_chat_id,
      `Hey${name}! Good news — you can now connect your Strava account. 🎉\n\nLinking Strava lets your coach see your real workout data and give you much better, personalised recommendations.`,
      stravaUrl
    );

    await supabase
      .from("users")
      .update({ strava_pending_reconnect: false })
      .eq("telegram_chat_id", user.telegram_chat_id);

    console.log(`✓ Notified and cleared flag for chat_id=${user.telegram_chat_id}`);
  } catch (err) {
    console.error(`✗ Failed for chat_id=${user.telegram_chat_id}: ${err.message}`);
  }
}

console.log("Done.");
