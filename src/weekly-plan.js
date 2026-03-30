/**
 * Weekly plan generator — runs every Sunday night
 * 1. Fetches last week's Strava activities
 * 2. Generates a 7-day plan via OpenAI
 * 3. Saves plan.json (committed back to repo by GitHub Actions)
 * 4. Sends a weekly plan summary to Telegram
 */

import { writeFileSync } from "fs";
import { getActivitiesLastWeek } from "./strava.js";
import { generateWeeklyPlan } from "./claude.js";
import { sendMessage } from "./telegram.js";

async function main() {
  console.log("Fetching last week's Strava activities...");
  const activities = await getActivitiesLastWeek();
  console.log(`Found ${activities.length} activities.`);

  console.log("Generating weekly plan with OpenAI...");
  const plan = await generateWeeklyPlan(activities);

  // Save plan to file (GitHub Actions will commit this back to the repo)
  writeFileSync("plan.json", JSON.stringify(plan, null, 2));
  console.log("plan.json saved.");

  // Send weekly summary to Telegram
  const days = Object.entries(plan.plan);
  const summary = days
    .map(([day, details]) => `*${day}:* ${details.workout} (${details.duration})`)
    .join("\n");

  const message =
    `*Your Workout Plan — Week of ${plan.weekStarting}*\n\n` +
    `${summary}\n\n` +
    `_Stay consistent and listen to your body!_`;

  await sendMessage(message);
  console.log("Weekly plan sent to Telegram.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
