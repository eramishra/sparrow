/**
 * Vercel Cron — daily at 9 PM IST (15:30 UTC)
 *
 * Checks that the Strava webhook feedback pipeline is working for each
 * Strava-connected user. If a user has a recent activity (within 7 days)
 * but zero feedback calls in that same period, the pipeline is likely broken
 * and we alert via Telegram.
 *
 * Runs after users have had time to complete their workouts for the day.
 */

import { createClient } from "@supabase/supabase-js";
import { sendMessage } from "../../src/telegram.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const issues = [];

  // Get all Strava-connected, fully onboarded users (exclude test accounts)
  const { data: users } = await supabase
    .from("users")
    .select("id, display_name, telegram_chat_id, strava_connected")
    .eq("strava_connected", true)
    .eq("onboarding_step", "done")
    .not("telegram_chat_id", "like", "test-%");

  if (!users?.length) {
    console.log("[health-check] No Strava-connected users found");
    return res.status(200).json({ ok: true, checked: 0 });
  }

  for (const user of users) {
    // Has any activity in the last 7 days?
    const { data: recentActivities } = await supabase
      .from("fitness_activities")
      .select("id, name, activity_date")
      .eq("user_id", user.id)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1);

    if (!recentActivities?.length) continue; // no recent activity, nothing to check

    // Has any feedback call in the last 7 days?
    const { data: recentFeedback } = await supabase
      .from("llm_usage")
      .select("id")
      .eq("user_id", user.id)
      .eq("call_type", "feedback")
      .gte("created_at", since)
      .limit(1);

    if (!recentFeedback?.length) {
      const lastActivity = recentActivities[0];
      issues.push({ user, lastActivity });
      console.warn(`[health-check] No feedback for ${user.display_name} — last activity: ${lastActivity.name} on ${lastActivity.activity_date}`);
    } else {
      console.log(`[health-check] ${user.display_name} OK — feedback pipeline working`);
    }
  }

  // Alert ops channel
  if (issues.length > 0) {
    const lines = issues.map(({ user, lastActivity }) =>
      `• *${user.display_name}* — last activity: ${lastActivity.name} on ${lastActivity.activity_date}, no feedback generated`
    );
    await sendMessage(
      process.env.ADMIN_CHAT_ID,
      `⚠️ *Feedback pipeline broken*\n\n${lines.join("\n")}\n\nCheck Vercel logs for strava-webhook errors.`
    ).catch(err => console.error(`[health-check] Failed to send alert: ${err.message}`));
  }

  console.log(`[health-check] Done. ${users.length} users checked, ${issues.length} issues found.`);
  return res.status(200).json({ ok: true, checked: users.length, issues: issues.length });
}
