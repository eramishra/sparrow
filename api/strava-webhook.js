/**
 * Strava Webhook — receives real-time activity events
 *
 * GET  /api/strava-webhook  — subscription verification (one-time, called by Strava)
 * POST /api/strava-webhook  — activity event handler (called on every new activity)
 */

import { getUserByStravaAthleteId, upsertUser, saveActivities, getLatestPlan } from "../src/supabase.js";
import { refreshStravaToken, getActivityById } from "../src/strava.js";
import { sendMessage } from "../src/telegram.js";
import { generateActivityFeedback } from "../src/ai.js";

export default async function handler(req, res) {
  // ── Subscription verification (GET) ───────────────────────────────────────
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
      console.log("[strava-webhook] Subscription verified");
      return res.status(200).json({ "hub.challenge": challenge });
    }
    return res.status(403).json({ error: "Forbidden" });
  }

  // ── Activity event (POST) ──────────────────────────────────────────────────
  if (req.method === "POST") {
    const { object_type, aspect_type, object_id: activityId, owner_id: stravaAthleteId } = req.body;

    // Acknowledge immediately — Strava requires a 200 within 2 seconds
    res.status(200).json({ ok: true });

    if (object_type !== "activity" || aspect_type !== "create") return;

    try {
      const user = await getUserByStravaAthleteId(stravaAthleteId);
      if (!user || !user.strava_connected) {
        console.log(`[strava-webhook] No connected user for athlete_id=${stravaAthleteId}`);
        return;
      }

      let tokens;
      try {
        tokens = await refreshStravaToken(user.strava_refresh_token);
      } catch (err) {
        if (err.message === "STRAVA_APP_NOT_APPROVED") {
          console.warn(`[strava-webhook] App not yet approved by Strava — skipping activity ${activityId} for athlete_id=${stravaAthleteId}`);
          return;
        }
        throw err;
      }
      if (tokens.refreshToken && tokens.refreshToken !== user.strava_refresh_token) {
        await upsertUser(user.telegram_chat_id, { strava_refresh_token: tokens.refreshToken });
      }

      const activity = await getActivityById(tokens.accessToken, activityId);
      await saveActivities(user.id, [activity]);
      console.log(`[strava-webhook] Saved activity ${activityId} for user ${user.telegram_chat_id}`);

      const plan = await getLatestPlan(user.id);
      const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const activityDayName = DAY_NAMES[new Date(activity.startDateIso).getDay()];
      const plannedDay = plan?.plan?.[activityDayName] ?? null;

      const llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
      const feedback = await generateActivityFeedback(activity, plannedDay, llmConfig);
      const activityHeader = `🏃 *${activity.name}* synced\n${activity.distanceKm}km · ${activity.durationMin} min${activity.avgHeartRate ? ` · ${activity.avgHeartRate} bpm avg HR` : ""}`;
      await sendMessage(user.telegram_chat_id, `${activityHeader}\n\n${feedback}`);
    } catch (err) {
      console.error(`[strava-webhook] ERROR for athlete_id=${stravaAthleteId}: ${err.message}\n${err.stack}`);
    }
  }
}
