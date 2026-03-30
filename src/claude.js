/**
 * Claude (Anthropic) integration
 * Generates a 7-day workout plan based on last week's Strava activities
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function formatActivities(activities) {
  if (activities.length === 0) return "None recorded.";
  return activities
    .map(
      (a) =>
        `- ${a.date}: ${a.type} — ${a.distanceKm}km, ${a.durationMin} min` +
        (a.avgHeartRate ? `, avg HR ${a.avgHeartRate} bpm` : "") +
        (a.elevationGain ? `, ${a.elevationGain}m elevation` : "")
    )
    .join("\n");
}

export async function generateWeeklyPlan(recentActivities, historyActivities) {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() + 1); // Plan starts Monday

  const prompt = `You are a personal fitness coach. Using the athlete's 3-month activity history for fitness context and last week's activities for current load, create a balanced 7-day workout plan for the upcoming week starting ${monday.toDateString()}.

Last 3 months of activity history (for fitness level & trend context):
${formatActivities(historyActivities)}

Last week's activities (for current load & recovery needs):
${formatActivities(recentActivities)}

Return ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "weekStarting": "${monday.toDateString()}",
  "generatedAt": "${new Date().toISOString()}",
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
- Balance intensity based on last week's load
- Include at least 1-2 rest or recovery days
- Match workout types to what the athlete already does
- Consider fitness trends from the 3-month history (improving, plateau, overtraining signs)
- Keep notes practical and motivating (1 sentence max)`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.content[0].text.trim();

  try {
    return JSON.parse(content);
  } catch {
    // Strip markdown code fences if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1].trim());
    throw new Error(`Claude returned invalid JSON: ${content}`);
  }
}
