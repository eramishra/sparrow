/**
 * Weekly plan generator — runs every Sunday night
 * 1. Reads fitness-history.json for long-term context
 * 2. Fetches last 7 days from Strava
 * 3. Appends new activities to history (dedup by id, rolling 6 months)
 * 4. Reads context.md for user goals/events
 * 5. Generates a 7-day plan via Claude
 * 6. Saves plan.json and fitness-history.json (both committed back by GitHub Actions)
 * 7. Sends weekly plan summary to Telegram
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { getActivitiesSince } from "./strava.js";
import { generateWeeklyPlan } from "./claude.js";
import { sendMessage } from "./telegram.js";

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

function loadHistory() {
  if (!existsSync("fitness-history.json")) return { lastUpdated: null, activities: [] };
  return JSON.parse(readFileSync("fitness-history.json", "utf8"));
}

function mergeAndPrune(history, newActivities) {
  const existingIds = new Set(history.activities.map((a) => a.id));
  const merged = [
    ...history.activities,
    ...newActivities.filter((a) => !existingIds.has(a.id)),
  ];

  const cutoff = new Date(Date.now() - SIX_MONTHS_MS).toISOString();
  return merged.filter((a) => a.startDateIso >= cutoff);
}

async function main() {
  // Load history and fetch this week's activities in parallel
  const history = loadHistory();
  console.log(`Loaded ${history.activities.length} activities from history.`);

  const fetchSince = history.lastUpdated ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`Fetching Strava activities since ${fetchSince}...`);
  const recentActivities = await getActivitiesSince(fetchSince);
  console.log(`Found ${recentActivities.length} new activities.`);

  // Merge new activities into history and prune to 6 months
  const updatedActivities = mergeAndPrune(history, recentActivities);
  const updatedHistory = { lastUpdated: new Date().toISOString(), activities: updatedActivities };
  writeFileSync("fitness-history.json", JSON.stringify(updatedHistory, null, 2));
  console.log(`History updated: ${updatedActivities.length} total activities.`);

  // Read user context (goals, upcoming events, etc.)
  const contextMd = existsSync("context.md") ? readFileSync("context.md", "utf8") : "";

  // Generate plan
  console.log("Generating weekly plan with Claude...");
  const plan = await generateWeeklyPlan(recentActivities, updatedActivities, contextMd);

  writeFileSync("plan.json", JSON.stringify(plan, null, 2));
  console.log("plan.json saved.");

  // Send weekly summary to Telegram
  const summary = Object.entries(plan.plan)
    .map(([day, d]) => `*${day}:* ${d.workout} (${d.duration})`)
    .join("\n");

  await sendMessage(
    `*Your Workout Plan — Week of ${plan.weekStarting}*\n\n${summary}\n\n_Stay consistent and listen to your body!_`
  );
  console.log("Weekly plan sent to Telegram.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
