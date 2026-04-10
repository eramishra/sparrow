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

  let allUsers;
  try {
    allUsers = await getAllActiveUsers();
  } catch (err) {
    console.error("[daily-reminder] Failed to fetch users:", err.message, err.stack);
    return res.status(500).json({ error: "Failed to fetch users", detail: err.message });
  }
  const users = allUsers.filter(u => !/^test-/i.test(String(u.telegram_chat_id)));
  console.log(`[daily-reminder] Processing ${users.length} users (${allUsers.length - users.length} test users skipped)`);
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

  if (failed > 0) {
    const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8659046367";
    await sendMessage(ADMIN_CHAT_ID,
      `⚠️ Daily reminder cron finished with errors: ${success} ok, ${failed} failed. Check Vercel logs.`
    ).catch(() => {});
  }

  res.status(200).json({ ok: true, success, failed });
}
