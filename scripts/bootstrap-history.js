/**
 * ONE-TIME bootstrap script — run locally with your .env file
 * Fetches last 3 months of Strava data and saves fitness-history.json
 *
 * Usage:
 *   cp .env.example .env   # fill in your credentials
 *   node --env-file=.env scripts/bootstrap-history.js
 */

import { writeFileSync } from "fs";
import { getActivities } from "../src/strava.js";

async function main() {
  console.log("Fetching last 90 days of Strava activities...");
  const activities = await getActivities(90);
  console.log(`Found ${activities.length} activities.`);

  const history = {
    lastUpdated: new Date().toISOString(),
    activities,
  };

  writeFileSync("fitness-history.json", JSON.stringify(history, null, 2));
  console.log("fitness-history.json saved. Commit this file to the repo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
