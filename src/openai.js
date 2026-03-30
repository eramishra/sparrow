/**
 * OpenAI integration
 * Generates a 7-day workout plan based on last week's Strava activities
 */

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateWeeklyPlan(activities) {
  const activitySummary =
    activities.length === 0
      ? "No activities recorded last week (rest week)."
      : activities
          .map(
            (a) =>
              `- ${a.date}: ${a.type} — ${a.distanceKm}km, ${a.durationMin} min` +
              (a.avgHeartRate ? `, avg HR ${a.avgHeartRate} bpm` : "") +
              (a.elevationGain ? `, ${a.elevationGain}m elevation` : "")
          )
          .join("\n");

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() + 1); // Plan starts Monday

  const prompt = `You are a personal fitness coach. Based on the athlete's activities from last week, create a balanced 7-day workout plan for the upcoming week starting ${monday.toDateString()}.

Last week's activities:
${activitySummary}

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
- Keep notes practical and motivating (1 sentence max)`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  const content = response.choices[0].message.content.trim();

  try {
    return JSON.parse(content);
  } catch {
    // Strip markdown code fences if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1].trim());
    throw new Error(`OpenAI returned invalid JSON: ${content}`);
  }
}
