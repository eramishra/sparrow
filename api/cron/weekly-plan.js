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

  const allUsers = await getAllActiveUsers();
  // Exclude test users from production cron to avoid burning quota
  const users = allUsers.filter(u => !/^test-/i.test(String(u.telegram_chat_id)));
  console.log(`Generating weekly plans for ${users.length} users (${allUsers.length - users.length} test users skipped)`);

  const today = new Date();
  const monday = new Date(today);
  const daysUntilMonday = today.getDay() === 0 ? 1 : 8 - today.getDay();
  monday.setDate(today.getDate() + daysUntilMonday);

  let success = 0, failed = 0;

  for (const user of users) {
    try {
      // Sync Strava activities first (errors are non-fatal — plan still generates from cached data)
      if (user.strava_connected && user.strava_refresh_token) {
        try {
          const lastDate = await getLastActivityDate(user.id);
          const since = lastDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          const { activities, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
          if (newToken !== user.strava_refresh_token) await upsertUser(user.telegram_chat_id, { strava_refresh_token: newToken });
          await saveActivities(user.id, activities);
        } catch (stravaErr) {
          if (stravaErr.message === "STRAVA_DEAUTHORIZED") {
            await upsertUser(user.telegram_chat_id, { strava_connected: false }).catch(() => {});
            await sendMessage(user.telegram_chat_id, "Your Strava connection has expired. Use /connect to reconnect.").catch(() => {});
          } else {
            console.warn(`[weekly-plan] Strava sync failed for chat_id=${user.telegram_chat_id}: ${stravaErr.message} — continuing with cached activities`);
          }
        }
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
    }
  }

  if (failed > 0) {
    const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8659046367";
    await sendMessage(ADMIN_CHAT_ID,
      `⚠️ Weekly plan cron finished with errors: ${success} ok, ${failed} failed. Check Vercel logs.`
    ).catch(() => {});
  }

  res.status(200).json({ ok: true, success, failed });
}
