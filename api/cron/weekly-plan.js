/**
 * Vercel Cron — every Sunday 8 PM IST (14:30 UTC)
 * Generates a weekly workout plan for every active user
 */

import { getAllActiveUsers, getLastActivityDate, saveActivities, saveWeeklyPlan, upsertUser, saveUsage } from "../../src/supabase.js";
import { getActivitiesSince } from "../../src/strava.js";
import { answerQuestion } from "../../src/ai.js";
import { sendMessage } from "../../src/telegram.js";
import { generateAndSavePlan } from "../../src/plan.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = await getAllActiveUsers();
  console.log(`Generating weekly plans for ${users.length} users`);

  const today = new Date();
  const monday = new Date(today);
  const daysUntilMonday = today.getDay() === 0 ? 1 : 8 - today.getDay();
  monday.setDate(today.getDate() + daysUntilMonday);

  let success = 0, failed = 0;

  for (const user of users) {
    try {
      // Sync Strava activities first
      if (user.strava_connected && user.strava_refresh_token) {
        const lastDate = await getLastActivityDate(user.id);
        const since = lastDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const { activities, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
        if (newToken !== user.strava_refresh_token) await upsertUser(user.telegram_chat_id, { strava_refresh_token: newToken });
        await saveActivities(user.id, activities);
      }

      const { plan, llmConfig, recent, usage: planUsage } = await generateAndSavePlan(user, monday);
      saveUsage(user.id, "plan", planUsage.provider, planUsage.model, planUsage.inputTokens, planUsage.outputTokens);

      const userProfile = { fitnessLevel: user.fitness_level, fitnessGoal: user.fitness_goal, daysPerWeek: user.days_per_week, gender: user.gender, weightKg: user.weight_kg, age: user.age, heightCm: user.height_cm };
      const { text: message, usage: qaUsage } = await answerQuestion(
        "Write out my complete workout plan for next week in full detail.",
        plan,
        recent,
        user.context_notes,
        llmConfig,
        userProfile
      );
      saveUsage(user.id, "qa", qaUsage.provider, qaUsage.model, qaUsage.inputTokens, qaUsage.outputTokens);
      await sendMessage(user.telegram_chat_id, `*Your Workout Plan — Week of ${plan.weekStarting}*\n\n${message}`);

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
