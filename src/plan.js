/**
 * Shared plan generation + saving logic
 * Used by cron, webhook /newplan, /update, and strava-webhook
 */

import { getActiveDays, saveWeeklyPlan } from "./supabase.js";
import { generateWeeklyPlan } from "./ai.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDERED_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Returns true if the Strava activity type matches the planned workout type.
 * Rest/recovery days never match — stay silent for those.
 */
export function activityMatchesPlan(activity, plannedDay) {
  if (!plannedDay) return false;
  if (/rest|recovery/i.test(plannedDay.workout)) return false;

  const plan = plannedDay.workout.toLowerCase();
  const act = activity.type.toLowerCase();

  if (/run|jog/i.test(plan) && /run/i.test(act)) return true;
  if (/bike|cycl|ride/i.test(plan) && /ride|bike/i.test(act)) return true;
  if (/swim/i.test(plan) && /swim/i.test(act)) return true;
  if (/strength|weight|gym|lift/i.test(plan) && /weight|strength|crossfit/i.test(act)) return true;
  if (/walk/i.test(plan) && /walk/i.test(act)) return true;
  if (/yoga|stretch|mobility/i.test(plan) && /yoga/i.test(act)) return true;
  // Strava's generic "Workout" type — match any non-rest planned activity
  if (act === "workout") return true;

  return false;
}

/**
 * Compares the weekly plan against actual activities for days that have already passed.
 * Returns { divergenceCount, missedDays, mismatchedDays }.
 * Significant divergence = divergenceCount >= 2.
 */
export function checkWeekDivergence(plan, activities) {
  if (!plan?.plan) return { divergenceCount: 0, missedDays: [], mismatchedDays: [] };

  const today = new Date();
  const todayName = DAY_NAMES[today.getDay()];
  const todayIndex = ORDERED_DAYS.indexOf(todayName);

  // Only check days that have fully passed (not today)
  const pastDays = ORDERED_DAYS.slice(0, todayIndex);

  const missedDays = [];
  const mismatchedDays = [];

  for (const day of pastDays) {
    const plannedDay = plan.plan[day];
    if (!plannedDay || /rest|recovery/i.test(plannedDay.workout)) continue;

    // Find the calendar date for this day in the current plan week
    const weekStart = new Date(plan.week_starting);
    const dayOffset = ORDERED_DAYS.indexOf(day); // 0=Mon
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + dayOffset);
    const dayStr = dayDate.toISOString().slice(0, 10);

    const dayActivities = activities.filter(a =>
      (a.started_at || a.startDateIso || "").slice(0, 10) === dayStr
    );

    if (dayActivities.length === 0) {
      missedDays.push(day);
    } else if (!dayActivities.some(a => activityMatchesPlan(a, plannedDay))) {
      mismatchedDays.push(day);
    }
  }

  return {
    divergenceCount: missedDays.length + mismatchedDays.length,
    missedDays,
    mismatchedDays,
  };
}

export async function generateAndSavePlan(user, startDate = null) {
  const activities = await getActiveDays(user.id, 30, 180);

  const llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
  const userProfile = {
    fitnessLevel: user.fitness_level,
    fitnessGoal: user.fitness_goal,
    daysPerWeek: user.days_per_week,
    gender: user.gender,
    weightKg: user.weight_kg,
    age: user.age,
    heightCm: user.height_cm,
  };

  const start = startDate ? new Date(startDate) : (() => {
    const d = new Date();
    const daysUntilMonday = d.getDay() === 0 ? 1 : 8 - d.getDay();
    d.setDate(d.getDate() + daysUntilMonday);
    return d;
  })();

  const planResult = await generateWeeklyPlan(activities, user.context_notes, user.fitness_background, llmConfig, start, userProfile);
  const { usage, ...plan } = planResult;
  await saveWeeklyPlan(user.id, new Date(start).toISOString().split("T")[0], plan.plan);

  return { plan, llmConfig, recent: activities, usage };
}
