/**
 * Vercel serverless webhook handler — multi-user with onboarding state machine
 *
 * Onboarding steps: awaiting_fitness_level → awaiting_strava → done
 *
 * Commands (active users):
 *   /update <text>  — append to context notes
 *   /plan           — show current week's plan
 *   /connect        — reconnect Strava
 *   anything else   — Q&A via Gemini
 */

import { getUserByChatId, upsertUser, appendContext, getLatestPlan, getActivitiesForUser, getLastActivityDate, saveActivities } from "../src/supabase.js";
import { sendMessage } from "../src/telegram.js";
import { answerQuestion } from "../src/gemini.js";
import { getActivitiesSince } from "../src/strava.js";

function getStravaAuthUrl(chatId) {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${process.env.APP_URL}/api/strava-callback`,
    scope: "activity:read_all",
    approval_prompt: "force",
    state: String(chatId),
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

async function handleOnboarding(user, chatId, text) {
  if (user.onboarding_step === "awaiting_fitness_level") {
    const isNew = /\b(a|new|beginner|start|just|never|0|1)\b/i.test(text);
    const background = isNew ? "new_to_fitness" : "already_active";
    await upsertUser(chatId, { fitness_background: background, onboarding_step: "awaiting_strava" });
    const authUrl = getStravaAuthUrl(chatId);
    await sendMessage(
      chatId,
      (isNew ? "Welcome! Starting fresh is exciting 💪\n\n" : "Great, let's import your training history!\n\n") +
        `Connect your Strava account so I can track your activities:\n${authUrl}\n\n` +
        "_Don't have Strava? Send /skip to continue without it._"
    );
    return;
  }

  if (user.onboarding_step === "awaiting_strava") {
    if (text === "/skip") {
      await upsertUser(chatId, { onboarding_step: "done" });
      await sendMessage(
        chatId,
        "No problem! I'll build you a plan based on your goals.\n\nUse `/update <goal>` to save your fitness goals, then ask me anything!"
      );
    } else {
      const authUrl = getStravaAuthUrl(chatId);
      await sendMessage(chatId, `Still waiting for Strava 🔗\n\n[Click here to connect](${authUrl})\n\n_Send /skip to continue without Strava._`);
    }
  }
}

async function handleActiveUser(user, chatId, text) {
  if (text.startsWith("/update ")) {
    await appendContext(user.id, text.slice(8).trim());
    await sendMessage(chatId, `Got it! Saved:\n_"${text.slice(8).trim()}"_\n\nThis will be factored into your next weekly plan.`);
    return;
  }

  if (text === "/plan") {
    const plan = await getLatestPlan(user.id);
    if (!plan) {
      await sendMessage(chatId, "No plan yet! Your first plan will be generated this Sunday at 8 PM IST.");
      return;
    }
    const summary = Object.entries(plan.plan).map(([day, d]) => `*${day}:* ${d.workout} (${d.duration})`).join("\n");
    await sendMessage(chatId, `*Your Current Plan — week of ${plan.week_starting}*\n\n${summary}`);
    return;
  }

  if (text === "/connect") {
    await sendMessage(chatId, `Connect your Strava account:\n${getStravaAuthUrl(chatId)}`);
    return;
  }

  // Q&A with live Strava fetch
  const [plan, recentFromDb] = await Promise.all([
    getLatestPlan(user.id),
    getActivitiesForUser(user.id, new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  let recentActivities = recentFromDb;

  if (user.strava_connected && user.strava_refresh_token) {
    try {
      const lastDate = await getLastActivityDate(user.id);
      const since = lastDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { activities: liveActivities, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
      if (newToken !== user.strava_refresh_token) await upsertUser(chatId, { strava_refresh_token: newToken });
      if (liveActivities.length > 0) {
        await saveActivities(user.id, liveActivities);
        recentActivities = await getActivitiesForUser(user.id, new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString());
      }
    } catch (err) {
      if (err.message === "STRAVA_DEAUTHORIZED") {
        await upsertUser(chatId, { strava_connected: false });
        await sendMessage(chatId, "Your Strava connection has expired. Use /connect to reconnect.");
      }
      console.error("Live Strava fetch failed:", err.message);
    }
  }

  const answer = await answerQuestion(text, plan, recentActivities, user.context_notes);
  await sendMessage(chatId, answer);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(403).end();

  try {
    const { message } = req.body;
    if (!message?.text) return res.status(200).json({ ok: true });

    const chatId = String(message.chat.id);
    const text = message.text.trim();
    let user = await getUserByChatId(chatId);

    if (!user) {
      await upsertUser(chatId, { display_name: message.from?.first_name || "there", onboarding_step: "awaiting_fitness_level" });
      await sendMessage(
        chatId,
        `Hi ${message.from?.first_name || "there"}! 🐦 Welcome to *Sparrow*, your AI fitness coach.\n\n` +
          "Tell me about your fitness background:\n\n" +
          "*A)* I'm new to fitness / just getting started\n" +
          "*B)* I've been training for a while"
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/start") {
      if (user.onboarding_step === "done") {
        await sendMessage(chatId, `Welcome back! 🐦\n\n• Ask me anything about your training\n• /plan — current week's plan\n• /update <text> — save goals or events\n• /connect — reconnect Strava`);
      } else {
        await upsertUser(chatId, { onboarding_step: "awaiting_fitness_level" });
        await sendMessage(chatId, `Let's get you set up! 🐦\n\n*A)* I'm new to fitness\n*B)* I've been training for a while`);
      }
      return res.status(200).json({ ok: true });
    }

    if (user.onboarding_step !== "done") {
      await handleOnboarding(user, chatId, text);
    } else {
      await handleActiveUser(user, chatId, text);
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  res.status(200).json({ ok: true });
}
