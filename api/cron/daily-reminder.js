/**
 * Vercel Cron — every night 8 PM IST (14:30 UTC)
 * Sends tomorrow's workout to every active user
 */

import { getAllActiveUsers, getLatestPlan } from "../../src/supabase.js";
import { sendMessage } from "../../src/telegram.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getTomorrowName() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return DAYS[tomorrow.getDay()];
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = await getAllActiveUsers();
  const tomorrow = getTomorrowName();
  let success = 0, failed = 0;

  for (const user of users) {
    try {
      const plan = await getLatestPlan(user.id);
      if (!plan?.plan?.[tomorrow]) continue;
      const { workout, duration, notes } = plan.plan[tomorrow];
      await sendMessage(
        user.telegram_chat_id,
        `*Tomorrow's Workout — ${tomorrow}*\n\n*What:* ${workout}\n*Duration:* ${duration}\n*Notes:* ${notes}\n\n_Get your gear ready tonight!_`
      );
      success++;
    } catch (err) {
      failed++;
      console.error(`[daily-reminder] ERROR for chat_id=${user.telegram_chat_id}: ${err.message}\n${err.stack}`);
    }
  }

  res.status(200).json({ ok: true, success, failed });
}
