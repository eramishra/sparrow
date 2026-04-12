/**
 * Shared plan generation + saving logic
 * Used by cron, webhook /newplan, /update, and strava-webhook
 */

import { getActiveDays, saveWeeklyPlan, getPlanForWeek } from "./supabase.js";
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

function getMondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const daysToMonday = d.getDay() === 0 ? 6 : d.getDay() - 1;
  d.setDate(d.getDate() - daysToMonday);
  return d;
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

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Normalise the requested start date
  let planStart = startDate ? new Date(startDate) : null;
  if (planStart) planStart.setHours(0, 0, 0, 0);

  // Determine week_starting (always a Monday) and the actual first day to generate
  let weekStarting, effectivePlanStart;
  const thisMonday = getMondayOfWeek(today);
  const nextMonday = new Date(thisMonday);
  nextMonday.setDate(thisMonday.getDate() + 7);

  if (!planStart || planStart >= nextMonday) {
    // Cron path (or no date): planStart IS a future Monday — generate full week
    weekStarting = planStart ?? nextMonday;
    effectivePlanStart = weekStarting;
  } else {
    // /newplan or mid-week divergence: planStart is today (current week)
    weekStarting = thisMonday;

    if (today.getDay() === 0) {
      // Sunday: always generate for the coming full week (Mon–Sun)
      weekStarting = nextMonday;
      effectivePlanStart = nextMonday;
    } else {
      // Mon–Sat: generate from today through Sunday
      effectivePlanStart = today;
    }
  }

  const weekStartingStr = weekStarting.toISOString().slice(0, 10);

  const planResult = await generateWeeklyPlan(activities, user.context_notes, user.fitness_background, llmConfig, effectivePlanStart, userProfile);
  const { usage, ...generated } = planResult;

  // Merge: if generating mid-week, preserve existing plan days before today
  let finalPlanDays = generated.plan;
  const effectivePlanStartStr = effectivePlanStart.toISOString().slice(0, 10);
  if (effectivePlanStartStr !== weekStartingStr) {
    const existing = await getPlanForWeek(user.id, weekStartingStr);
    if (existing?.plan) {
      const todayName = DAY_NAMES[today.getDay()];
      const todayIndex = ORDERED_DAYS.indexOf(todayName);
      const merged = {};
      for (const day of ORDERED_DAYS) {
        if (ORDERED_DAYS.indexOf(day) < todayIndex && existing.plan[day]) {
          merged[day] = existing.plan[day];
        }
      }
      Object.assign(merged, finalPlanDays);
      finalPlanDays = merged;
    }
  }

  await saveWeeklyPlan(user.id, weekStartingStr, finalPlanDays);

  return { plan: { ...generated, plan: finalPlanDays }, llmConfig, recent: activities, usage };
}
