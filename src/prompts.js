/**
 * Shared prompt builders for all AI providers
 */

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

export function buildPlanPrompt(recentActivities, historyActivities, contextNotes = "", fitnessBackground = "already_active") {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() + 1);

  const contextSection = contextNotes.trim() ? `\nAthlete context & upcoming events:\n${contextNotes.trim()}\n` : "";
  const backgroundNote =
    fitnessBackground === "new_to_fitness"
      ? "\nThis athlete is new to fitness — keep the plan gentle with shorter durations and plenty of rest.\n"
      : "";

  return `You are an expert personal fitness coach creating a structured 7-day workout plan.
${backgroundNote}${contextSection}
## Athlete's Activity History (last 6 months)
${formatActivities(historyActivities)}

## Last Week's Activities (for load & recovery context)
${formatActivities(recentActivities)}

## Instructions
Create a realistic, well-balanced weekly plan starting ${monday.toDateString()}. For each day:
- workout: specific activity name (e.g. "Easy 5km Run", "Upper Body Strength", "Rest Day")
- duration: time range (e.g. "45-60 min", "30 min", "—")
- notes: one actionable coaching tip for that session

Rules:
- Include 1-2 rest or active recovery days based on recent load
- Match workout types to what the athlete already does
- Vary intensity: hard days followed by easy or rest days
- Factor in any upcoming events or constraints mentioned in context

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "weekStarting": "${monday.toDateString()}",
  "plan": {
    "Monday": { "workout": "...", "duration": "...", "notes": "..." },
    "Tuesday": { "workout": "...", "duration": "...", "notes": "..." },
    "Wednesday": { "workout": "...", "duration": "...", "notes": "..." },
    "Thursday": { "workout": "...", "duration": "...", "notes": "..." },
    "Friday": { "workout": "...", "duration": "...", "notes": "..." },
    "Saturday": { "workout": "...", "duration": "...", "notes": "..." },
    "Sunday": { "workout": "...", "duration": "...", "notes": "..." }
  }
}`;
}

export function buildQAPrompt(question, plan, recentActivities, contextNotes = "") {
  const contextSection = contextNotes.trim() ? `\nAthlete context:\n${contextNotes.trim()}\n` : "";
  const planSummary = plan?.plan
    ? Object.entries(plan.plan)
        .map(([day, d]) => `${day}: ${d.workout} (${d.duration}) — ${d.notes}`)
        .join("\n")
    : "No plan available yet.";

  return `You are a knowledgeable, supportive personal fitness coach. Answer the athlete's question directly and specifically — 3-5 sentences, plain conversational text, no bullet points or headers.
${contextSection}
Current week's plan (${plan?.week_starting ?? plan?.weekStarting ?? ""}):
${planSummary}

Recent activities:
${formatActivities(recentActivities)}

Athlete's question: ${question}`;
}
