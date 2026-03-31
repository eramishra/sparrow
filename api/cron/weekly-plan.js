/**
 * Vercel Cron — every Sunday 8 PM IST (14:30 UTC)
 * Generates a weekly workout plan for every active user
 */

import { getAllActiveUsers, getActivitiesForUser, getLastActivityDate, saveActivities, saveWeeklyPlan, upsertUser } from "../../src/supabase.js";
import { getActivitiesSince } from "../../src/strava.js";
import { generateWeeklyPlan } from "../../src/ai.js";
import { sendMessage } from "../../src/telegram.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = await getAllActiveUsers();
  console.log(`Generating weekly plans for ${users.length} users`);

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() + 1);
  const weekStarting = monday.toISOString().split("T")[0];

  let success = 0, failed = 0;

  for (const user of users) {
    try {
      let recentActivities = [];

      if (user.strava_connected && user.strava_refresh_token) {
        const lastDate = await getLastActivityDate(user.id);
        const since = lastDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const { activities, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
        if (newToken !== user.strava_refresh_token) await upsertUser(user.telegram_chat_id, { strava_refresh_token: newToken });
        await saveActivities(user.id, activities);
        recentActivities = activities;
      }

      const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
      const history = await getActivitiesForUser(user.id, sixMonthsAgo);
      const llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
      const plan = await generateWeeklyPlan(recentActivities, history, user.context_notes, user.fitness_background, llmConfig);

      await saveWeeklyPlan(user.id, weekStarting, plan);

      const summary = Object.entries(plan.plan).map(([day, d]) => `*${day}:* ${d.workout} (${d.duration})`).join("\n");
      await sendMessage(user.telegram_chat_id, `*Your Workout Plan — Week of ${plan.weekStarting}*\n\n${summary}\n\n_Stay consistent and listen to your body!_`);

      success++;
      console.log(`Plan generated for ${user.telegram_chat_id}`);
    } catch (err) {
      failed++;
      console.error(`[weekly-plan] ERROR for chat_id=${user.telegram_chat_id}: ${err.message}\n${err.stack}`);
      if (err.message === "STRAVA_DEAUTHORIZED") {
        await upsertUser(user.telegram_chat_id, { strava_connected: false }).catch(() => {});
        await sendMessage(user.telegram_chat_id, "Your Strava connection has expired. Use /connect to reconnect.").catch(() => {});
      }
    }
  }

  res.status(200).json({ ok: true, success, failed });
}
