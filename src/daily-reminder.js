/**
 * Daily reminder — runs every night
 * Reads plan.json and sends tomorrow's workout to Telegram
 */

import { readFileSync } from "fs";
import { sendMessage } from "./telegram.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getTomorrowName() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return DAYS[tomorrow.getDay()];
}

async function main() {
  let plan;
  try {
    plan = JSON.parse(readFileSync("plan.json", "utf8"));
  } catch {
    throw new Error("plan.json not found. Has the weekly plan been generated yet?");
  }

  const tomorrow = getTomorrowName();
  const workout = plan.plan[tomorrow];

  if (!workout) {
    throw new Error(`No workout found for ${tomorrow} in plan.json`);
  }

  const message =
    `*Tomorrow's Workout — ${tomorrow}*\n\n` +
    `*What:* ${workout.workout}\n` +
    `*Duration:* ${workout.duration}\n` +
    `*Notes:* ${workout.notes}\n\n` +
    `_Get your gear ready tonight!_`;

  await sendMessage(message);
  console.log(`Reminder sent for ${tomorrow}: ${workout.workout}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
