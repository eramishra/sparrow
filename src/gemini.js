/**
 * Gemini AI integration
 * Generates weekly workout plans and answers fitness questions
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function formatActivities(activities) {
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

export async function generateWeeklyPlan(recentActivities, historyActivities, contextNotes = "", fitnessBackground = "already_active") {
  const model = genai.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() + 1);

  const contextSection = contextNotes.trim() ? `\nAthlete context & upcoming events:\n${contextNotes.trim()}\n` : "";
  const backgroundNote =
    fitnessBackground === "new_to_fitness"
      ? "\nNote: This athlete is new to fitness. Create a gentle, beginner-friendly plan with shorter durations, plenty of rest days, and encouragement.\n"
      : "";

  const prompt = `You are a personal fitness coach. Create a balanced 7-day workout plan for the upcoming week starting ${monday.toDateString()}.
${backgroundNote}${contextSection}
Activity history — last 6 months (fitness level context):
${formatActivities(historyActivities)}

Last week's activities (current load & recovery needs):
${formatActivities(recentActivities)}

Return a JSON object with this exact structure:
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
}

Guidelines:
- Balance intensity based on recent load
- Include 1-2 rest or recovery days
- Match workout types to what the athlete already does
- Factor in upcoming events or constraints from context
- Keep notes practical and motivating (1 sentence max)`;

  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

export async function answerQuestion(question, plan, recentActivities, contextNotes = "") {
  const model = genai.getGenerativeModel({ model: "gemini-1.5-flash" });

  const contextSection = contextNotes.trim() ? `\nAthlete context:\n${contextNotes.trim()}\n` : "";
  const planSummary = plan?.plan
    ? Object.entries(plan.plan)
        .map(([day, d]) => `${day}: ${d.workout} (${d.duration}) — ${d.notes}`)
        .join("\n")
    : "No plan available yet.";

  const prompt = `You are a personal fitness coach assistant. Answer the athlete's question based on their current plan and recent activity history. Be concise and practical (3-5 sentences max).
${contextSection}
Current week's plan (week of ${plan?.week_starting ?? plan?.weekStarting ?? ""}):
${planSummary}

Recent activities:
${formatActivities(recentActivities)}

Question: ${question}`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}
