/**
 * Shared prompt builders for all AI providers
 */

const ORDERED_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const GOAL_LABELS = {
  endurance: "Build Endurance (running, cycling, swimming)",
  weight: "Lose Weight",
  strength: "Build Strength",
  general: "General Fitness",
};

function formatGoals(fitnessGoal) {
  if (!fitnessGoal) return "Not specified";
  return fitnessGoal.split(",").filter(Boolean).map(g => GOAL_LABELS[g.trim()] || g.trim()).join(", ");
}

function formatProfile(userProfile = {}) {
  const { fitnessLevel, fitnessGoal, daysPerWeek, gender, weightKg, age, heightCm } = userProfile;
  if (!fitnessLevel && !fitnessGoal && !daysPerWeek && !gender && !weightKg && !age && !heightCm) return "";
  const lines = [
    fitnessLevel && `- Fitness Level: ${fitnessLevel}`,
    fitnessGoal && `- Goals: ${formatGoals(fitnessGoal)}`,
    daysPerWeek && `- Available training days: ${daysPerWeek} days/week`,
    gender && `- Gender: ${gender}`,
    age && `- Age: ${age}`,
    weightKg && `- Weight: ${weightKg} kg`,
    heightCm && `- Height: ${heightCm} cm`,
  ].filter(Boolean);
  return `\n## Athlete Profile\n${lines.join("\n")}\n`;
}

export function getRemainingDays(planDays) {
  const todayName = DAY_NAMES[new Date().getDay()];
  const todayIndex = ORDERED_DAYS.indexOf(todayName);
  return Object.fromEntries(
    Object.entries(planDays).filter(([day]) => ORDERED_DAYS.indexOf(day) >= todayIndex)
  );
}

export function formatActivities(activities) {
  if (!activities || activities.length === 0) return "None recorded.";
  return activities
    .map(
      (a) =>
        `- ${new Date(a.started_at || a.startDateIso).toDateString()}: ${a.type} — ${a.distance_km ?? a.distanceKm}km, ${a.duration_min ?? a.durationMin} min` +
        ((a.avg_heart_rate ?? a.avgHeartRate) ? `, avg HR ${a.avg_heart_rate ?? a.avgHeartRate} bpm` : "") +
        ((a.elevation_gain ?? a.elevationGain) ? `, ${a.elevation_gain ?? a.elevationGain}m elevation` : "")
    )
    .join("\n");
}

export function buildPlanPrompt(recentActivities, historyActivities, contextNotes = "", fitnessBackground = "already_active", startDate = null, userProfile = {}) {
  const start = startDate ? new Date(startDate) : (() => {
    const d = new Date();
    const daysUntilMonday = d.getDay() === 0 ? 1 : 8 - d.getDay();
    d.setDate(d.getDate() + daysUntilMonday);
    return d;
  })();

  const startDayName = DAY_NAMES[start.getDay()];
  const startIndex = ORDERED_DAYS.indexOf(startDayName);
  const daysToGenerate = startIndex === -1 ? ORDERED_DAYS : ORDERED_DAYS.slice(startIndex);

  const jsonTemplate = daysToGenerate
    .map((day) => `    "${day}": { "workout": "...", "duration": "...", "notes": "..." }`)
    .join(",\n");

  const contextSection = contextNotes.trim() ? `\nAthlete context & upcoming events:\n${contextNotes.trim()}\n` : "";
  const backgroundNote =
    fitnessBackground === "new_to_fitness"
      ? "\nThis athlete is new to fitness — keep the plan gentle with shorter durations and plenty of rest.\n"
      : "";

  return `You are an expert personal fitness coach creating a structured workout plan.
${formatProfile(userProfile)}${backgroundNote}${contextSection}
## Athlete's Activity History (last 6 months)
${formatActivities(historyActivities)}

## Last Week's Activities (for load & recovery context)
${formatActivities(recentActivities)}

## Instructions
Create a realistic, well-balanced plan from ${start.toDateString()} through Sunday. For each day:
- workout: specific activity name (e.g. "Easy 5km Run", "Upper Body Strength", "Rest Day")
- duration: time range (e.g. "45-60 min", "30 min", "—")
- notes: one crisp, highly actionable coaching tip — tell the athlete exactly what to do, no fluff

Rules:
- Include rest or active recovery days based on recent load
- Match workout types to what the athlete already does
- Vary intensity: hard days followed by easy or rest days
- Factor in any upcoming events or constraints mentioned in context

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "weekStarting": "${start.toDateString()}",
  "plan": {
${jsonTemplate}
  }
}`;
}

export function buildActivityFeedbackPrompt(activity, plannedDay) {
  const actual = [
    `Type: ${activity.type}`,
    activity.distanceKm ? `Distance: ${activity.distanceKm}km` : null,
    activity.durationMin ? `Duration: ${activity.durationMin} min` : null,
    activity.avgHeartRate ? `Avg HR: ${activity.avgHeartRate} bpm` : null,
    activity.elevationGain ? `Elevation: ${activity.elevationGain}m` : null,
  ].filter(Boolean).join(", ");

  const planned = plannedDay
    ? `${plannedDay.workout} (${plannedDay.duration}) — ${plannedDay.notes}`
    : "No specific workout planned for today";

  const isRestDay = plannedDay && /rest|recovery/i.test(plannedDay.workout);

  return `You are a warm, direct personal fitness coach. Your athlete just completed a workout. Send them a short coaching message (3–4 sentences max).

Today's plan: ${planned}
What they actually did: ${actual}

Guidelines:
- If they matched or exceeded the plan: celebrate with their specific numbers, add one forward-looking tip
- If they fell short: stay encouraging, acknowledge what they did, give one actionable note
${isRestDay ? "- They trained on a rest day: acknowledge the effort but gently flag that recovery is part of the plan\n" : ""}- Be specific — reference their actual numbers, not generic praise
- Warm coach tone, no fluff
- Use Telegram markdown (bold with *asterisks*, no other formatting)`;
}

export function buildHowToPrompt(exercise) {
  return `You are an expert strength and conditioning coach. Explain how to perform the following exercise: "${exercise}"

Structure your response exactly like this, using bold headers:

**What it is**
One sentence describing the exercise and its primary benefit.

**Setup**
Bullet points covering starting position, equipment, and stance.

**Key Form Cues**
3-5 crisp, actionable bullet points — what the athlete must focus on during the movement.

**Common Mistakes**
2-3 bullet points on what to avoid and why.

Keep it concise and practical. No fluff.`;
}

export function buildQAPrompt(question, plan, recentActivities, contextNotes = "", userProfile = {}) {
  const contextSection = contextNotes.trim() ? `\nAthlete context:\n${contextNotes.trim()}\n` : "";
  const remainingDays = plan?.plan ? getRemainingDays(plan.plan) : null;
  const planSummary = remainingDays && Object.keys(remainingDays).length > 0
    ? Object.entries(remainingDays)
        .map(([day, d]) => `${day}: ${d.workout} (${d.duration}) — ${d.notes}`)
        .join("\n")
    : "No plan available yet.";

  const today = new Date();
  const todayStr = `${DAY_NAMES[today.getDay()]}, ${today.toDateString()}`;

  return `You are a knowledgeable, supportive personal fitness coach. Answer the athlete's question with crisp, well-formatted responses using bold headers and bullet points. Be highly actionable — every point should tell the athlete exactly what to do. No fluff, no filler sentences.

Today's date: ${todayStr}
${formatProfile(userProfile)}${contextSection}
Current week's plan (${plan?.week_starting ?? plan?.weekStarting ?? ""}):
${planSummary}

Recent activities:
${formatActivities(recentActivities)}

Athlete's question: ${question}`;
}
