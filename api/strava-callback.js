/**
 * Strava OAuth callback — exchanges auth code for tokens, bootstraps history, generates first plan
 */

import { getUserByChatId, upsertUser, saveActivities, saveWeeklyPlan, getActivitiesForUser } from "../src/supabase.js";
import { getActivities } from "../src/strava.js";
import { generateWeeklyPlan } from "../src/ai.js";
import { sendMessage } from "../src/telegram.js";

export default async function handler(req, res) {
  const { code, state: chatId, error } = req.query;

  if (error) {
    if (chatId) await sendMessage(chatId, "Strava connection was cancelled. Type /connect to try again.").catch(() => {});
    return res.status(200).send("<html><body style='font-family:sans-serif;text-align:center;padding:40px'><h2>Connection cancelled.</h2><p>Return to Telegram and try again.</p></body></html>");
  }

  if (!code || !chatId) return res.status(400).send("Invalid callback.");

  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      if (tokenRes.status === 403) {
        if (chatId) {
          await upsertUser(chatId, { strava_pending_reconnect: true }).catch(() => {});
          await sendMessage(chatId, "Strava connection is temporarily unavailable — the app is pending Strava's approval for multiple users. We'll let you know once it's open. Sorry for the inconvenience!").catch(() => {});
        }
        return res.status(200).send("<html><body style='font-family:sans-serif;text-align:center;padding:40px'><h2>Strava connection unavailable.</h2><p>The app is pending Strava approval for multiple users. Return to Telegram — we'll notify you once it's open.</p></body></html>");
      }
      throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    const user = await getUserByChatId(chatId);
    if (!user) throw new Error(`User not found for chat_id ${chatId}`);

    const athlete = tokens.athlete || {};
    const updatedUser = await upsertUser(chatId, {
      strava_refresh_token: tokens.refresh_token,
      strava_access_token: tokens.access_token,
      strava_expires_at: tokens.expires_at,
      strava_athlete_id: String(athlete.id || ""),
      strava_connected: true,
      onboarding_step: "done",
      gender: athlete.sex === "M" ? "male" : athlete.sex === "F" ? "female" : null,
      weight_kg: athlete.weight || null,
    });

    await sendMessage(chatId, "Strava connected! ✅ Fetching your activity history...");

    const { activities } = await getActivities(tokens.refresh_token, 90);
    await saveActivities(updatedUser.id, activities);

    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [history, recent] = await Promise.all([
      getActivitiesForUser(updatedUser.id, sixMonthsAgo),
      getActivitiesForUser(updatedUser.id, weekAgo),
    ]);

    const llmConfig = { provider: updatedUser.preferred_llm || "gemini", apiKey: updatedUser.llm_api_key };
    const userProfile = { fitnessLevel: updatedUser.fitness_level, fitnessGoal: updatedUser.fitness_goal, daysPerWeek: updatedUser.days_per_week, gender: updatedUser.gender, weightKg: updatedUser.weight_kg, age: updatedUser.age, heightCm: updatedUser.height_cm };
    const plan = await generateWeeklyPlan(recent, history, updatedUser.context_notes || "", updatedUser.fitness_background, llmConfig, null, userProfile);

    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() + ((1 + 7 - today.getDay()) % 7 || 7));
    await saveWeeklyPlan(updatedUser.id, monday.toISOString().split("T")[0], plan.plan);

    const summary = Object.entries(plan.plan).map(([day, d]) => `*${day}:* ${d.workout} (${d.duration})`).join("\n");
    await sendMessage(chatId, `You're all set! 🎉 Here's your first weekly plan:\n\n${summary}\n\nYou'll get daily reminders at 8 PM IST and a fresh plan every Sunday.\n\nAsk me anything about your training anytime!`);

    res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Strava Connected</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0d;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:32px}.card{max-width:360px}.icon{font-size:56px;margin-bottom:20px}.title{font-size:24px;font-weight:700;margin-bottom:10px}.sub{font-size:15px;color:#888;line-height:1.5;margin-bottom:24px}.note{font-size:13px;color:#555}</style></head><body><div class="card"><div class="icon">✅</div><div class="title">Strava Connected!</div><div class="sub">Your activity history has been imported.<br/>Your first plan is ready in Telegram.</div><div class="note" id="msg">Closing automatically...</div></div><script>setTimeout(function(){window.close();},2000);setTimeout(function(){var el=document.getElementById('msg');if(el)el.textContent='You can close this tab.';},3000);</script></body></html>`);
  } catch (err) {
    console.error("[strava-callback] ERROR for chat_id=%s: %s\n%s", chatId, err.message, err.stack);
    if (chatId) await sendMessage(chatId, "Something went wrong. Please type /connect to try again.").catch((e) => console.error("[strava-callback] Failed to send error message:", e.message));
    res.status(500).send("<html><body style='font-family:sans-serif;text-align:center;padding:40px'><h2>Something went wrong.</h2><p>Return to Telegram and try /connect again.</p></body></html>");
  }
}
