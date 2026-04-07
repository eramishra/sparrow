/**
 * Sparrow Test CLI
 * Interactive terminal to test bot responses without going through Telegram
 *
 * Usage: node scripts/test-cli.mjs
 *
 * Commands:
 *   /plan              — show current week's plan
 *   /context           — show active context notes
 *   /context set <txt> — override context for this session
 *   /context clear     — clear context for this session
 *   /model             — show active AI model
 *   /model <provider>  — switch model: gemini | claude <key> | openai <key>
 *   /user              — show current user profile
 *   /reload            — reload user + plan from Supabase
 *   /exit              — quit
 *   anything else      — ask your AI coach
 */

import { createInterface } from "readline";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { generateWeeklyPlan, answerQuestion, generateActivityFeedback } from "../src/ai.js";
import { getRemainingDays } from "../src/prompts.js";

// ── Load env ───────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const [k, ...v] = l.split("=");
      return [k.trim(), v.join("=").replace(/^"|"$/g, "").trim()];
    })
);
Object.assign(process.env, env);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// ── Colours ────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};
const bold = (s) => `${c.bold}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;
const tag = (color, s) => `${color}${c.bold}${s}${c.reset}`;

// ── Load data ──────────────────────────────────────────────────────────────
async function loadUser(name = null) {
  let query = supabase.from("users").select("*");
  if (name) {
    query = query.ilike("display_name", `%${name}%`);
  } else {
    query = query.eq("onboarding_step", "done").order("created_at", { ascending: false }).limit(1);
  }
  const { data } = await query.maybeSingle();
  return data;
}

async function loadPlan(userId) {
  const { data } = await supabase
    .from("weekly_plans")
    .select("*")
    .eq("user_id", userId)
    .order("week_starting", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function loadActivities(userId) {
  const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("fitness_activities")
    .select("*")
    .eq("user_id", userId)
    .gte("started_at", since)
    .order("started_at", { ascending: false });
  return data || [];
}

// ── Format plan ────────────────────────────────────────────────────────────
function formatPlan(plan) {
  if (!plan) return dim("  No plan available.");
  const remaining = getRemainingDays(plan.plan);
  if (Object.keys(remaining).length === 0) return dim("  No remaining days this week.");
  return Object.entries(remaining)
    .map(([day, d]) => `  ${tag(c.cyan, day.padEnd(10))} ${bold(d.workout)} ${dim(`(${d.duration})`)}\n             ${dim(d.notes)}`)
    .join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  process.env.MOCK_TELEGRAM = "true"; // set before any webhook import — intercepts all Telegram calls
  const { handleActiveUser, handleOnboarding, handleCallbackQuery } = await import("../api/webhook.js");

  console.clear();
  console.log(bold(`\n🐦 Sparrow Test CLI`));
  console.log(dim("Loading data from Supabase...\n"));

  const nameArg = process.argv[2] || null;
  let user = await loadUser(nameArg);
  if (!user) {
    console.error(tag(c.red, "✗") + " No active users found in Supabase.");
    process.exit(1);
  }

  let plan = await loadPlan(user.id);
  let activities = await loadActivities(user.id);

  // Session overrides
  let sessionContext = user.context_notes;
  let llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };

  function printStatus() {
    console.log(`${tag(c.green, "✓")} Loaded user ${bold(user.display_name)} (${dim(user.telegram_chat_id)})`);
    console.log(`  Background : ${bold(user.fitness_background)}`);
    console.log(`  Model      : ${bold(llmConfig.provider)}`);
    console.log(`  Activities : ${bold(activities.length)} in last 28 days`);
    console.log(`  Plan       : ${plan ? bold("week of " + plan.week_starting) : dim("none")}`);
    console.log(`  Context    : ${sessionContext ? dim(sessionContext.slice(0, 80) + (sessionContext.length > 80 ? "…" : "")) : dim("(empty)")}`);
    console.log();
    console.log(dim("Type a message or /help for commands.\n"));
  }

  printStatus();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`${c.cyan}you${c.reset} › `);

  let closeRequested = false;
  function prompt() { if (!closeRequested) rl.prompt(); }

  // Serialize line processing so piped input runs steps sequentially
  let chain = Promise.resolve();

  rl.prompt();

  rl.on("line", (line) => {
    chain = chain.then(() => handleLine(line.trim()));
  });

  rl.on("close", () => {
    closeRequested = true;
    chain.then(() => { console.log(dim("\nBye!\n")); process.exit(0); });
  });

  async function handleLine(text) {
    if (!text) { prompt(); return; }
    try {

    // ── Commands ─────────────────────────────────────────────────────────
    if (text === "/exit" || text === "/quit") {
      console.log(dim("\nBye!\n")); process.exit(0);
    }

    if (text === "/help") {
      console.log(`
  ${bold("Commands")}
  ${tag(c.cyan, "/plan")}                  Show current week's plan
  ${tag(c.cyan, "/context")}               Show active context notes
  ${tag(c.cyan, "/context set <text>")}    Override context for this session
  ${tag(c.cyan, "/context clear")}         Clear context for this session
  ${tag(c.cyan, "/model")}                 Show active model
  ${tag(c.cyan, "/model gemini")}          Switch to Gemini
  ${tag(c.cyan, "/model claude <key>")}    Switch to Claude
  ${tag(c.cyan, "/model openai <key>")}    Switch to OpenAI
  ${tag(c.cyan, "/user")}                  Show full user profile
  ${tag(c.cyan, "/switch <name>")}         Switch to a different user
  ${tag(c.cyan, "/sim <text>")}            Simulate sending a message as the user (mock Telegram)
  ${tag(c.cyan, "/sim callback <data>")}  Simulate a button tap (e.g. /sim callback fl:beginner)
  ${tag(c.cyan, "/feedback")}             Simulate post-activity coaching for today's activity
  ${tag(c.cyan, "/reload")}                Reload data from Supabase
  ${tag(c.cyan, "/exit")}                  Quit
`);
      prompt(); return;
    }

    if (text === "/plan") {
      console.log(`\n${tag(c.magenta, "PLAN")} ${dim("week of " + (plan?.week_starting || "?"))}\n`);
      console.log(formatPlan(plan));
      console.log(); prompt(); return;
    }

    if (text === "/context") {
      console.log(`\n${tag(c.magenta, "CONTEXT")}\n${sessionContext ? sessionContext : dim("  (empty)")}\n`);
      prompt(); return;
    }

    if (text.startsWith("/context set ")) {
      sessionContext = text.slice(13).trim();
      console.log(`${tag(c.green, "✓")} Context set for this session.\n`);
      prompt(); return;
    }

    if (text === "/context clear") {
      sessionContext = "";
      console.log(`${tag(c.green, "✓")} Context cleared.\n`);
      prompt(); return;
    }

    if (text === "/model") {
      console.log(`\n${tag(c.magenta, "MODEL")} ${bold(llmConfig.provider)}\n`);
      prompt(); return;
    }

    if (text.startsWith("/model ")) {
      const parts = text.split(" ");
      const provider = parts[1];
      const apiKey = parts[2] || null;
      if (!["gemini", "claude", "openai"].includes(provider)) {
        console.log(`${tag(c.red, "✗")} Unknown provider. Use: gemini | claude <key> | openai <key>\n`);
      } else {
        llmConfig = { provider, apiKey };
        console.log(`${tag(c.green, "✓")} Switched to ${bold(provider)}.\n`);
      }
      prompt(); return;
    }

    if (text === "/user") {
      console.log(`\n${tag(c.magenta, "USER")}`);
      console.log(`  Name       : ${bold(user.display_name)}`);
      console.log(`  Chat ID    : ${dim(user.telegram_chat_id)}`);
      console.log(`  Background : ${bold(user.fitness_background)}`);
      console.log(`  Strava     : ${user.strava_connected ? tag(c.green, "connected") : tag(c.yellow, "not connected")}`);
      console.log(`  Model      : ${bold(llmConfig.provider)}`);
      console.log(`  Context    :\n${sessionContext ? sessionContext.split("\n").map(l => "    " + l).join("\n") : dim("    (empty)")}`);
      console.log(); prompt(); return;
    }

    if (text.startsWith("/switch ")) {
      const name = text.slice(8).trim();
      process.stdout.write(dim(`  Switching to "${name}"…`));
      const newUser = await loadUser(name);
      if (!newUser) {
        process.stdout.write("\r" + " ".repeat(30) + "\r");
        console.log(`${tag(c.red, "✗")} No user found matching "${name}".\n`);
      } else {
        user = newUser;
        plan = await loadPlan(user.id);
        activities = await loadActivities(user.id);
        sessionContext = user.context_notes;
        llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
        process.stdout.write("\r" + " ".repeat(30) + "\r");
        printStatus();
      }
      prompt(); return;
    }

    if (text === "/reload") {
      process.stdout.write(dim("  Reloading…"));
      user = await loadUser(user.display_name);
      plan = await loadPlan(user.id);
      activities = await loadActivities(user.id);
      sessionContext = user.context_notes;
      llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
      process.stdout.write("\r" + " ".repeat(20) + "\r");
      printStatus();
      prompt(); return;
    }

    if (text.startsWith("/sim ") || text === "/sim") {
      const arg = text.slice(5).trim();
      if (!arg) {
        console.log(`\n  Usage:\n  ${tag(c.cyan, "/sim <message>")}          Simulate sending a message\n  ${tag(c.cyan, "/sim callback <data>")}   Simulate a button tap\n`);
        prompt(); return;
      }

      process.stdout.write(`\n${tag(c.magenta, "SIM")} › ${dim(arg)} ${dim("(step: " + user.onboarding_step + ")")}\n`);
      try {
        if (arg.startsWith("callback ")) {
          const callbackData = arg.slice(9).trim();
          const fakeCallbackQuery = {
            id: "test_" + Date.now(),
            data: callbackData,
            message: { chat: { id: user.telegram_chat_id }, message_id: 999 },
          };
          await handleCallbackQuery(fakeCallbackQuery);
        } else {
          if (user.onboarding_step !== "done") {
            await handleOnboarding(user, user.telegram_chat_id, arg);
          } else {
            await handleActiveUser(user, user.telegram_chat_id, arg);
          }
        }
        user = await loadUser(user.display_name);
        console.log(dim(`\n  onboarding_step now: ${user.onboarding_step}`));
      } catch (err) {
        console.log(`\n${tag(c.red, "sim error")} › ${err.message}\n`);
      }
      console.log(); prompt(); return;
    }

    if (text === "/feedback") {
      const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const todayName = DAY_NAMES[new Date().getDay()];
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayActivity = activities.find(a => (a.started_at || a.startDateIso || "").slice(0, 10) === todayStr);
      if (!todayActivity) {
        console.log(`${tag(c.yellow, "?")} No activity found for today (${todayStr}).\n`);
        prompt(); return;
      }
      const plannedDay = plan?.plan?.[todayName] ?? null;
      console.log(`\n${tag(c.magenta, "ACTIVITY")} ${bold(todayActivity.name || todayActivity.type)} — ${todayActivity.distance_km ?? todayActivity.distanceKm}km, ${todayActivity.duration_min ?? todayActivity.durationMin} min`);
      console.log(`${tag(c.magenta, "PLANNED")}  ${plannedDay ? `${plannedDay.workout} (${plannedDay.duration})` : dim("none")}\n`);
      process.stdout.write(`${tag(c.blue, "sparrow")} › ${dim("generating feedback…")}`);
      const start = Date.now();
      try {
        const feedback = await generateActivityFeedback(todayActivity, plannedDay, llmConfig);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        process.stdout.write("\r" + " ".repeat(40) + "\r");
        console.log(`\n${tag(c.blue, "sparrow")} › ${feedback}\n`);
        console.log(dim(`  ${llmConfig.provider} · ${elapsed}s`));
      } catch (err) {
        process.stdout.write("\r" + " ".repeat(40) + "\r");
        console.log(`\n${tag(c.red, "error")} › ${err.message}\n`);
      }
      console.log(); prompt(); return;
    }

    if (text.startsWith("/")) {
      console.log(`${tag(c.yellow, "?")} Unknown command. Type /help for a list.\n`);
      prompt(); return;
    }

    // ── AI Q&A ────────────────────────────────────────────────────────────
    process.stdout.write(`\n${tag(c.blue, "sparrow")} › ${dim("thinking…")}`);
    const start = Date.now();
    try {
      const answer = await answerQuestion(text, plan, activities, sessionContext, llmConfig);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write("\r" + " ".repeat(30) + "\r");
      console.log(`\n${tag(c.blue, "sparrow")} › ${answer}\n`);
      console.log(dim(`  ${llmConfig.provider} · ${elapsed}s`));
    } catch (err) {
      process.stdout.write("\r" + " ".repeat(30) + "\r");
      console.log(`\n${tag(c.red, "error")} › ${err.message}\n`);
    }
    console.log();
    prompt();
    } catch (_outer) {}
  }
}

main();
