/**
 * Supabase database helpers
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function getUserByChatId(chatId) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_chat_id", String(chatId))
    .maybeSingle();
  return data;
}

export async function upsertUser(chatId, updates) {
  const { data, error } = await supabase
    .from("users")
    .upsert(
      { telegram_chat_id: String(chatId), ...updates, updated_at: new Date().toISOString() },
      { onConflict: "telegram_chat_id" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function saveActivities(userId, activities) {
  if (!activities.length) return;
  const rows = activities.map((a) => ({
    user_id: userId,
    strava_activity_id: a.id,
    activity_date: a.startDateIso.split("T")[0],
    started_at: a.startDateIso,
    type: a.type,
    distance_km: parseFloat(a.distanceKm),
    duration_min: a.durationMin,
    avg_heart_rate: a.avgHeartRate,
    elevation_gain: a.elevationGain,
    name: a.name,
  }));
  const { error } = await supabase
    .from("fitness_activities")
    .upsert(rows, { onConflict: "user_id,strava_activity_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function getActivitiesForUser(userId, sinceIso) {
  const { data, error } = await supabase
    .from("fitness_activities")
    .select("*")
    .eq("user_id", userId)
    .gte("started_at", sinceIso)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getLastActivityDate(userId) {
  const { data } = await supabase
    .from("fitness_activities")
    .select("started_at")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.started_at || null;
}

export async function saveWeeklyPlan(userId, weekStarting, plan) {
  const { error } = await supabase
    .from("weekly_plans")
    .upsert(
      { user_id: userId, week_starting: weekStarting, plan, generated_at: new Date().toISOString() },
      { onConflict: "user_id,week_starting" }
    );
  if (error) throw error;
}

export async function getLatestPlan(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("weekly_plans")
    .select("*")
    .eq("user_id", userId)
    .lte("week_starting", today)
    .order("week_starting", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function appendContext(userId, text) {
  const { data: user } = await supabase.from("users").select("context_notes").eq("id", userId).single();
  const timestamp = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const updated = ((user?.context_notes || "") + `\n- [${timestamp}] ${text}`).trim();
  await supabase.from("users").update({ context_notes: updated, updated_at: new Date().toISOString() }).eq("id", userId);
}

export async function getUserByStravaAthleteId(athleteId) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("strava_athlete_id", String(athleteId))
    .maybeSingle();
  return data;
}

export async function getAllActiveUsers() {
  const { data, error } = await supabase.from("users").select("*").eq("onboarding_step", "done");
  if (error) throw error;
  return data || [];
}
