/**
 * Vercel serverless webhook handler — multi-user with onboarding state machine
 *
 * Onboarding steps:
 *   awaiting_fitness_level → awaiting_goal → awaiting_days →
 *   awaiting_limitations → awaiting_events → awaiting_strava → done
 *
 * Commands (active users):
 *   /help               — list commands
 *   /plan               — show current week's plan
 *   /newplan            — generate fresh plan from today
 *   /update profile     — update fitness level, goals, and targets
 *   /howto <exercise>   — form cues + YouTube link
 *   /connect            — reconnect Strava
 *   /llm [provider key] — manage AI model
 *   anything else       — Q&A (with smart DB routing for plan queries)
 */

import { getUserByChatId, upsertUser, appendContext, getLatestPlan, getActivitiesForUser, getLastActivityDate, saveActivities, saveWeeklyPlan } from "../src/supabase.js";
import { sendMessage, sendMessageWithButtons, editMessageText, answerCallbackQuery } from "../src/telegram.js";
import { answerQuestion, generateWeeklyPlan, explainExercise, generateActivityFeedback } from "../src/ai.js";
import { getActivitiesSince } from "../src/strava.js";
import { generateAndSavePlan, checkWeekDivergence } from "../src/plan.js";

// ── LLM error classifier ─────────────────────────────────────────────────────

function isLlmOverloaded(err) {
  return err.message?.includes("503") || err.message?.includes("overloaded") || err.message?.includes("high demand") || err.message?.includes("rate limit") || err.message?.toLowerCase().includes("too many requests");
}

const LLM_BUSY_MSG = "My AI brain is a bit overwhelmed right now — please try again in a minute. 🧠";

// ── Onboarding keyboard helpers ─────────────────────────────────────────────

const FITNESS_LEVEL_KEYBOARD = [
  [{ text: "🌱 Beginner — haven't exercised in 2+ years", callback_data: "fl:beginner" }],
  [{ text: "🏃 Intermediate — recently started or getting back into it", callback_data: "fl:intermediate" }],
  [{ text: "🏆 Advanced — continuously active", callback_data: "fl:advanced" }],
];

const GOALS = [
  { key: "endurance", label: "Build Endurance" },
  { key: "weight",    label: "Lose Weight" },
  { key: "strength",  label: "Build Strength" },
  { key: "general",  label: "General Fitness" },
];

function buildGoalKeyboard(selected = []) {
  const rows = GOALS.map(g => [{
    text: (selected.includes(g.key) ? "✅ " : "⬜ ") + g.label,
    callback_data: `goal_toggle:${g.key}`,
  }]);
  rows.push([{ text: selected.length > 0 ? "✔ Confirm goals →" : "Skip →", callback_data: "goal_done" }]);
  return rows;
}

const GOAL_MSG = `*What's your primary goal?* 🎯\n\nTap to select (you can pick more than one):\n\n_💡 Tip: Stick to 1–2 goals. Combining strength + endurance training splits focus and slows progress in both._`;

const DAYS_KEYBOARD = [
  [1, 2, 3, 4].map(n => ({ text: String(n), callback_data: `days:${n}` })),
  [5, 6, 7].map(n => ({ text: String(n), callback_data: `days:${n}` })),
];


// ── Strava helpers ──────────────────────────────────────────────────────────

function getStravaAuthUrl(chatId) {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${process.env.APP_URL}/api/strava-callback`,
    scope: "activity:read_all",
    approval_prompt: "force",
    state: String(chatId),
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

// ── Smart plan routing (Backlog #1) ─────────────────────────────────────────

function getDirectPlanResponse(text, plan) {
  if (!plan?.plan) return null;
  if (!/\bplan\b/i.test(text)) return null;

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const today = new Date();
  let targetDay = null;

  if (/\btoday\b/i.test(text)) {
    targetDay = DAY_NAMES[today.getDay()];
  } else if (/\btomorrow\b/i.test(text)) {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    targetDay = DAY_NAMES[tomorrow.getDay()];
  } else {
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      if (new RegExp(`\\b${day}\\b`, "i").test(text)) { targetDay = day; break; }
    }
  }

  if (!targetDay || !plan.plan[targetDay]) return null;
  const d = plan.plan[targetDay];
  return `*${targetDay}'s Plan*\n\n• ${d.workout} (${d.duration})\n• ${d.notes}`;
}

// ── Callback query handler ──────────────────────────────────────────────────

export async function handleCallbackQuery(callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const user = await getUserByChatId(chatId);
  if (!user) return;

  await answerCallbackQuery(callbackQuery.id);

  const pu = user.onboarding_step?.startsWith("pu:");

  if (data.startsWith("fl:")) {
    if (user.onboarding_step !== "awaiting_fitness_level" && user.onboarding_step !== "pu:fitness_level") return;
    const level = data.slice(3);
    await upsertUser(chatId, { fitness_level: level, onboarding_step: pu ? "pu:goal" : "awaiting_goal" });
    await sendMessageWithButtons(chatId, GOAL_MSG, buildGoalKeyboard([]));
    return;
  }

  if (data.startsWith("goal_toggle:")) {
    if (user.onboarding_step !== "awaiting_goal" && user.onboarding_step !== "pu:goal") return;
    const goal = data.slice(12);
    const current = user.fitness_goal ? user.fitness_goal.split(",").filter(Boolean) : [];
    const idx = current.indexOf(goal);
    if (idx === -1) current.push(goal); else current.splice(idx, 1);
    await upsertUser(chatId, { fitness_goal: current.join(",") });
    await editMessageText(chatId, messageId, GOAL_MSG, buildGoalKeyboard(current));
    return;
  }

  if (data === "goal_done") {
    if (user.onboarding_step !== "awaiting_goal" && user.onboarding_step !== "pu:goal") return;
    await upsertUser(chatId, { onboarding_step: pu ? "pu:days" : "awaiting_days" });
    await sendMessageWithButtons(chatId, `*How many days per week can you train?* 📅`, DAYS_KEYBOARD);
    return;
  }

  if (data.startsWith("days:")) {
    if (user.onboarding_step !== "awaiting_days" && user.onboarding_step !== "pu:days") return;
    const days = parseInt(data.slice(5));
    await upsertUser(chatId, { days_per_week: days, onboarding_step: pu ? "pu:age" : "awaiting_age" });
    await sendMessage(chatId,
      `Got it — *${days} days/week* ✅\n\n` +
      `*How old are you?* 🎂\n\n` +
      `_Send /skip if you'd rather not say._`
    );
    return;
  }
}

// ── Onboarding handler ──────────────────────────────────────────────────────

export async function handleOnboarding(user, chatId, text) {
  const step = user.onboarding_step;
  const pu = step.startsWith("pu:"); // profile update mode

  if (step === "awaiting_fitness_level" || step === "pu:fitness_level") {
    await sendMessageWithButtons(chatId, `*What's your current fitness level?* 💪\n\nTap to select:`, FITNESS_LEVEL_KEYBOARD);
    return;
  }

  if (step === "awaiting_goal" || step === "pu:goal") {
    const current = user.fitness_goal ? user.fitness_goal.split(",").filter(Boolean) : [];
    await sendMessageWithButtons(chatId, GOAL_MSG, buildGoalKeyboard(current));
    return;
  }

  if (step === "awaiting_days" || step === "pu:days") {
    await sendMessageWithButtons(chatId, `*How many days per week can you train?* 📅`, DAYS_KEYBOARD);
    return;
  }

  if (step === "awaiting_age" || step === "pu:age") {
    if (text !== "/skip") {
      const age = parseInt(text);
      if (!isNaN(age) && age > 0 && age < 120) await upsertUser(chatId, { age });
      else { await sendMessage(chatId, `Please send a valid age (e.g. _28_) or /skip.`); return; }
    }
    await upsertUser(chatId, { onboarding_step: pu ? "pu:height" : "awaiting_height" });
    await sendMessage(chatId,
      `${text === "/skip" ? "" : "Got it! ✅\n\n"}` +
      `*What's your height?* 📏\n\n` +
      `Send in cm, e.g. _175_\n\n` +
      `_Send /skip if you'd rather not say._`
    );
    return;
  }

  if (step === "awaiting_height" || step === "pu:height") {
    if (text !== "/skip") {
      const height = parseInt(text);
      if (!isNaN(height) && height > 0 && height < 300) await upsertUser(chatId, { height_cm: height });
      else { await sendMessage(chatId, `Please send a valid height in cm (e.g. _175_) or /skip.`); return; }
    }
    await upsertUser(chatId, { onboarding_step: pu ? "pu:limitations" : "awaiting_limitations" });
    await sendMessage(chatId,
      `${text === "/skip" ? "" : "Got it! ✅\n\n"}` +
      `Do you have any injuries or physical limitations I should know about?\n\n` +
      `_Send /skip if none._`
    );
    return;
  }

  if (step === "awaiting_limitations" || step === "pu:limitations") {
    const next = pu ? "pu:events" : "awaiting_events";
    if (text !== "/skip") {
      if (pu) {
        const notes = (user.context_notes || "").split("\n").filter(l => !/injuries\/limitations:/i.test(l)).join("\n").trim();
        await upsertUser(chatId, { context_notes: notes ? `${notes}\n- Injuries/limitations: ${text}` : `- Injuries/limitations: ${text}` });
      } else {
        await appendContext(user.id, `Injuries/limitations: ${text}`);
      }
    }
    await upsertUser(chatId, { onboarding_step: next });
    await sendMessage(chatId,
      `${text === "/skip" ? "" : "Noted! ✅\n\n"}` +
      `*Any fitness targets or upcoming events?* 🎯\n\n` +
      `Send them as numbered points, one per line:\n` +
      `_1. Half marathon in September\n2. Lose 6kg by December\n3. Cycle 100km by June_\n\n` +
      `_Send /skip if none._`
    );
    return;
  }

  if (step === "awaiting_events" || step === "pu:events") {
    if (text !== "/skip") {
      if (pu) {
        const notes = (user.context_notes || "").split("\n").filter(l => !/target\/event:/i.test(l)).join("\n").trim();
        await upsertUser(chatId, { context_notes: notes ? `${notes}\n- Target/event: ${text}` : `- Target/event: ${text}` });
      } else {
        await appendContext(user.id, `Target/event: ${text}`);
      }
    }
    if (pu) {
      await upsertUser(chatId, { onboarding_step: "done" });
      await sendMessage(chatId, `Profile updated! ✅\n\nUse /newplan to generate a fresh plan with your updated profile.`);
    } else {
      await upsertUser(chatId, { onboarding_step: "awaiting_strava" });
      if (process.env.STRAVA_APP_PENDING?.trim() === "true") {
        await upsertUser(chatId, { strava_pending_reconnect: true });
        await sendMessage(chatId,
          `Almost done! 🐦\n\n` +
          `Strava connection is temporarily unavailable — the app is pending Strava's approval for multiple users. We'll notify you as soon as it's open!\n\n` +
          `_Send /skip to continue without Strava for now. You'll be notified when Strava is ready._`
        );
      } else {
        const authUrl = getStravaAuthUrl(chatId);
        await sendMessage(chatId,
          `Almost done! 🐦\n\n` +
          `*Connect Strava to unlock the full power of Sparrow:*\n\n` +
          `• Every workout syncs automatically after you complete it\n` +
          `• Your plans adapt based on what you *actually* did, not just what was planned\n` +
          `• Without Strava, Sparrow has no way to know your real training load\n\n` +
          `Strava is *free* on the basic plan — no subscription needed.\n\n` +
          `[Connect Strava →](${authUrl})\n\n` +
          `_Send /skip to continue without Strava. Plan quality will be limited._`
        );
      }
    }
    return;
  }

  if (step === "awaiting_strava") {
    if (text === "/skip") {
      await upsertUser(chatId, { onboarding_step: "done" });
      await sendMessage(chatId,
        `You're all set! 🐦\n\nSend /newplan to generate your first training plan.\n\n_You can connect Strava anytime with /connect_`
      );
    } else if (process.env.STRAVA_APP_PENDING?.trim() === "true") {
      await upsertUser(chatId, { strava_pending_reconnect: true });
      await sendMessage(chatId, `Strava connection is temporarily unavailable — the app is pending Strava's approval. We'll notify you as soon as it's open!\n\n_Send /skip to continue without Strava for now._`);
    } else {
      const authUrl = getStravaAuthUrl(chatId);
      await sendMessage(chatId, `Still waiting for Strava 🔗\n\n[Click here to connect](${authUrl})\n\n_Send /skip to continue without Strava._`);
    }
  }
}

// ── Active user handler ─────────────────────────────────────────────────────

export async function handleActiveUser(user, chatId, text) {

  if (text === "/help") {
    await sendMessage(chatId,
      `*Sparrow Commands* 🐦\n\n` +
      `*Plans*\n` +
      `• /plan — show current week's plan\n` +
      `• /newplan — generate a fresh plan starting today\n` +
      `• /checkplan — check if your week has drifted and refresh if needed\n` +
      `• /feedback — get coaching feedback on your latest activity\n\n` +
      `*Exercise Guide*\n` +
      `• /howto <exercise> — form cues + YouTube link\n\n` +
      `*Profile*\n` +
      `• /profile — view your fitness profile and saved context\n` +
      `• /update profile — update fitness level, goals, and targets\n\n` +
      `*Settings*\n` +
      `• /connect — connect or reconnect Strava\n` +
      `• /llm — show current AI model\n` +
      `• /llm gemini — switch to Gemini (free)\n` +
      `• /llm claude <api_key> — switch to Claude\n` +
      `• /llm openai <api_key> — switch to GPT-4o mini\n` +
      `• /reset — reset profile and restart onboarding\n\n` +
      `_Or just ask me anything about your training!_`
    );
    return;
  }

  if (text.startsWith("/howto ")) {
    const exercise = text.slice(7).trim();
    if (!exercise) {
      await sendMessage(chatId, "Usage: `/howto <exercise>` — e.g. `/howto barbell squat`");
      return;
    }
    const llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
    try {
      const explanation = await explainExercise(exercise, llmConfig);
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(exercise + " proper form")}`;
      await sendMessage(chatId, `${explanation}\n\n🎥 [Watch on YouTube](${searchUrl})`);
    } catch (err) {
      await sendMessage(chatId, isLlmOverloaded(err) ? LLM_BUSY_MSG : "Couldn't look that up. Try again in a moment.");
    }
    return;
  }

  if (text === "/profile") {
    const GOAL_LABELS = { endurance: "Build Endurance", weight: "Lose Weight", strength: "Build Strength", general: "General Fitness" };
    const LEVEL_LABELS = { beginner: "🌱 Beginner", intermediate: "🏃 Intermediate", advanced: "🏆 Advanced" };
    const level = LEVEL_LABELS[user.fitness_level] || user.fitness_level || "Not set";
    const goals = user.fitness_goal
      ? user.fitness_goal.split(",").filter(Boolean).map(g => GOAL_LABELS[g.trim()] || g).join(", ")
      : "Not set";
    const days = user.days_per_week ? `${user.days_per_week} days/week` : "Not set";
    const context = user.context_notes?.trim() || "None";
    await sendMessage(chatId,
      `*Your Profile* 🐦\n\n` +
      `*Fitness level:* ${level}\n` +
      `*Goals:* ${goals}\n` +
      `*Training days:* ${days}\n` +
      (user.age ? `*Age:* ${user.age}\n` : "") +
      (user.height_cm ? `*Height:* ${user.height_cm} cm\n` : "") +
      (user.weight_kg ? `*Weight:* ${user.weight_kg} kg _(from Strava)_\n` : "") +
      (user.gender ? `*Gender:* ${user.gender} _(from Strava)_\n` : "") +
      `\n*Context & targets:*\n${context}\n\n` +
      `_Use /update profile to update your profile._`
    );
    return;
  }

  if (text === "/update profile") {
    await upsertUser(chatId, { onboarding_step: "pu:fitness_level" });
    await sendMessageWithButtons(chatId, `*Update your fitness level* 💪\n\nTap to select:`, FITNESS_LEVEL_KEYBOARD);
    return;
  }

  if (text === "/plan") {
    const plan = await getLatestPlan(user.id);
    if (!plan) {
      await sendMessage(chatId, "No plan yet! Use /newplan to generate one now, or wait until Sunday at 8 PM IST.");
      return;
    }
    const DAY_ORDER = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
    const summary = DAY_ORDER.filter(d => plan.plan[d]).map(d => {
      const day = plan.plan[d];
      const notes = day.notes ? `\n  _${day.notes}_` : "";
      return `*${d}:* ${day.workout} (${day.duration})${notes}`;
    }).join("\n");
    await sendMessage(chatId, `*Your Current Plan — week of ${plan.week_starting}*\n\n${summary}`);
    return;
  }

  if (text === "/newplan") {
    await sendMessage(chatId, "Generating your fresh plan... 🏃");
    if (user.strava_connected && user.strava_refresh_token) {
      try {
        const lastDate = await getLastActivityDate(user.id);
        const since = lastDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const { activities, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
        if (newToken !== user.strava_refresh_token) await upsertUser(chatId, { strava_refresh_token: newToken });
        await saveActivities(user.id, activities);
      } catch (err) {
        if (err.message === "STRAVA_DEAUTHORIZED") {
          await upsertUser(chatId, { strava_connected: false });
          await sendMessage(chatId, "Your Strava connection has expired. Use /connect to reconnect.");
          return;
        }
      }
    }
    const { plan } = await generateAndSavePlan(user, new Date());
    const summary = Object.entries(plan.plan)
      .map(([day, d]) => `*${day}*\n• ${d.workout} (${d.duration})\n• ${d.notes}`)
      .join("\n\n");
    await sendMessage(chatId, `*Your Fresh Plan — from ${new Date().toDateString()}*\n\n${summary}`);
    return;
  }

  if (text === "/checkplan") {
    const plan = await getLatestPlan(user.id);
    if (!plan) {
      await sendMessage(chatId, "No plan found. Use /newplan to generate one.");
      return;
    }

    // Sync latest Strava activities first
    let activities = await getActivitiesForUser(user.id, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
    if (user.strava_connected && user.strava_refresh_token) {
      try {
        const lastDate = await getLastActivityDate(user.id);
        const since = lastDate ?? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const { activities: live, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
        if (newToken !== user.strava_refresh_token) await upsertUser(chatId, { strava_refresh_token: newToken });
        if (live.length > 0) {
          await saveActivities(user.id, live);
          activities = await getActivitiesForUser(user.id, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
        }
      } catch (err) {
        if (err.message === "STRAVA_DEAUTHORIZED") {
          await upsertUser(chatId, { strava_connected: false });
          await sendMessage(chatId, "Your Strava connection has expired. Use /connect to reconnect.");
          return;
        }
      }
    }

    const { divergenceCount, missedDays, mismatchedDays } = checkWeekDivergence(plan, activities);

    if (divergenceCount >= 2) {
      await sendMessage(chatId, `Your week has drifted from the plan — regenerating now... 🔄\n\n_Missed: ${missedDays.join(", ") || "none"}_\n_Different activity: ${mismatchedDays.join(", ") || "none"}_`);
      const freshUser = await getUserByChatId(chatId);
      const { plan: newPlan } = await generateAndSavePlan(freshUser, new Date());
      const summary = Object.entries(newPlan.plan)
        .map(([day, d]) => `*${day}*\n• ${d.workout} (${d.duration})\n• ${d.notes}`)
        .join("\n\n");
      await sendMessage(chatId, `*Updated Plan — from ${new Date().toDateString()}*\n\n${summary}`);
    } else if (divergenceCount === 1) {
      const drifted = [...missedDays, ...mismatchedDays].join(", ");
      await sendMessage(chatId, `Plan looks mostly on track ✅\n\nOne day drifted (${drifted}) but not enough to warrant a full reset. Keep going with the current plan or use /newplan to start fresh.`);
    } else {
      await sendMessage(chatId, `You're right on track this week 💪 No changes needed to your plan.`);
    }
    return;
  }

  if (text === "/feedback") {
    if (!user.strava_connected || !user.strava_refresh_token) {
      await sendMessage(chatId, "Strava isn't connected — no activity data available. Use /connect to link it.");
      return;
    }
    await sendMessage(chatId, "_Fetching your latest activity..._");
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { activities, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
      if (newToken !== user.strava_refresh_token) await upsertUser(chatId, { strava_refresh_token: newToken });
      if (!activities.length) {
        await sendMessage(chatId, "No activities in the last 24 hours found on Strava.");
        return;
      }
      const activity = activities[0];
      const plan = await getLatestPlan(user.id);
      const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const plannedDay = plan?.plan?.[DAY_NAMES[new Date(activity.startDateIso).getDay()]] ?? null;
      const llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
      const feedback = await generateActivityFeedback(activity, plannedDay, llmConfig);
      const header = `🏃 *${activity.name}*\n${activity.distanceKm}km · ${activity.durationMin} min${activity.avgHeartRate ? ` · ${activity.avgHeartRate} bpm avg HR` : ""}`;
      await sendMessage(chatId, `${header}\n\n${feedback}`);
    } catch (err) {
      console.error(`[/feedback] ERROR for chat_id=${chatId}: ${err.message}`);
      if (err.message === "STRAVA_DEAUTHORIZED") {
        await upsertUser(chatId, { strava_connected: false });
        await sendMessage(chatId, "Your Strava connection has expired. Use /connect to reconnect.");
      } else if (isLlmOverloaded(err)) {
        await sendMessage(chatId, LLM_BUSY_MSG);
      } else {
        await sendMessage(chatId, "Couldn't fetch your activity. Try again in a moment.");
      }
    }
    return;
  }

  if (text === "/connect") {
    if (process.env.STRAVA_APP_PENDING?.trim() === "true" && !user.strava_connected) {
      await upsertUser(chatId, { strava_pending_reconnect: true });
      await sendMessage(chatId, "Strava connection is temporarily unavailable — the app is pending Strava's approval for multiple users. We'll notify you as soon as it's open. Sorry for the wait!");
      return;
    }
    await sendMessage(chatId, `Connect your Strava account: [Click here](${getStravaAuthUrl(chatId)})`);
    return;
  }

  if (text.startsWith("/llm")) {
    const parts = text.split(" ");
    const provider = parts[1]?.toLowerCase();
    const apiKey = parts[2]?.trim();
    if (!provider || provider === "status") {
      const current = user.preferred_llm || "gemini";
      await sendMessage(chatId, `Current AI: *${current}*\n\nTo switch:\n• \`/llm gemini\` — free, default\n• \`/llm claude <api_key>\` — Claude Haiku\n• \`/llm openai <api_key>\` — GPT-4o mini`);
      return;
    }
    if (provider === "gemini") {
      await upsertUser(chatId, { preferred_llm: "gemini", llm_api_key: null });
      await sendMessage(chatId, "Switched to *Gemini* (free tier). ✅");
      return;
    }
    if ((provider === "claude" || provider === "openai") && apiKey) {
      await upsertUser(chatId, { preferred_llm: provider, llm_api_key: apiKey });
      await sendMessage(chatId, `Switched to *${provider}*. ✅\n\n_Delete your previous message to keep your API key private._`);
      return;
    }
    await sendMessage(chatId, `Usage: \`/llm gemini\` or \`/llm claude <api_key>\` or \`/llm openai <api_key>\``);
    return;
  }

  // Q&A — send acknowledgment first, then process
  await sendMessage(chatId, "_Let me check on that..._");

  const [plan, recentFromDb] = await Promise.all([
    getLatestPlan(user.id),
    getActivitiesForUser(user.id, new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  // Backlog #1 — smart routing: return from DB for simple plan queries
  const directResponse = getDirectPlanResponse(text, plan);
  if (directResponse) {
    await sendMessage(chatId, directResponse);
    return;
  }

  let recentActivities = recentFromDb;
  if (user.strava_connected && user.strava_refresh_token) {
    try {
      const lastDate = await getLastActivityDate(user.id);
      const since = lastDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { activities: liveActivities, refreshToken: newToken } = await getActivitiesSince(user.strava_refresh_token, since);
      if (newToken !== user.strava_refresh_token) await upsertUser(chatId, { strava_refresh_token: newToken });
      if (liveActivities.length > 0) {
        await saveActivities(user.id, liveActivities);
        recentActivities = await getActivitiesForUser(user.id, new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString());
      }
    } catch (err) {
      if (err.message === "STRAVA_DEAUTHORIZED") {
        await upsertUser(chatId, { strava_connected: false });
        await sendMessage(chatId, "Your Strava connection has expired. Use /connect to reconnect.");
      }
      console.error("Live Strava fetch failed:", err.message);
    }
  }

  const llmConfig = { provider: user.preferred_llm || "gemini", apiKey: user.llm_api_key };
  const userProfile = { fitnessLevel: user.fitness_level, fitnessGoal: user.fitness_goal, daysPerWeek: user.days_per_week, gender: user.gender, weightKg: user.weight_kg, age: user.age, heightCm: user.height_cm };
  try {
    const answer = await answerQuestion(text, plan, recentActivities, user.context_notes, llmConfig, userProfile);
    await sendMessage(chatId, answer);
  } catch (err) {
    console.error(`[Q&A] ERROR for chat_id=${chatId}: ${err.message}`);
    await sendMessage(chatId, isLlmOverloaded(err) ? LLM_BUSY_MSG : "Something went wrong. Please try again.");
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(403).end();

  const { message, callback_query } = req.body;
  if (callback_query) {
    try {
      await handleCallbackQuery(callback_query);
    } catch (err) {
      console.error("[webhook] callback_query ERROR: %s\n%s", err.message, err.stack);
      try {
        const chatId = String(callback_query.message?.chat?.id);
        if (chatId) await sendMessage(chatId, `Something went wrong. Please try again.`);
      } catch (_) {}
    }
    return res.status(200).json({ ok: true });
  }

  try {
    if (!message?.text) return res.status(200).json({ ok: true });

    const chatId = String(message.chat.id);
    const text = message.text.trim();
    let user = await getUserByChatId(chatId);

    if (!user) {
      await upsertUser(chatId, { display_name: message.from?.first_name || "there", onboarding_step: "awaiting_fitness_level" });
      await sendMessage(chatId,
        `Hi ${message.from?.first_name || "there"}! 🐦 Welcome to *Sparrow*, your AI fitness coach.\n\n` +
        `I'll create a personalised training plan for you. Let's set up your profile first!`
      );
      await sendMessageWithButtons(chatId, `*What's your current fitness level?* 💪\n\nTap to select:`, FITNESS_LEVEL_KEYBOARD);
      return res.status(200).json({ ok: true });
    }

    if (text === "/start") {
      if (user.onboarding_step === "done") {
        await sendMessage(chatId, `Welcome back! 🐦\n\n• Ask me anything about your training\n• /plan — current week's plan\n• /newplan — generate a fresh plan starting today\n• /update profile — update your fitness profile\n• /connect — reconnect Strava\n• /help — all commands`);
      } else {
        await upsertUser(chatId, { onboarding_step: "awaiting_fitness_level" });
        await sendMessageWithButtons(chatId, `*What's your current fitness level?* 💪\n\nTap to select:`, FITNESS_LEVEL_KEYBOARD);
      }
      return res.status(200).json({ ok: true });
    }

    if (text === "/reset") {
      await upsertUser(chatId, {
        onboarding_step: "awaiting_fitness_level",
        fitness_level: null,
        fitness_goal: null,
        days_per_week: null,
        context_notes: "",
      });
      await sendMessage(chatId, `Profile reset. Let's start fresh! 🐦`);
      await sendMessageWithButtons(chatId, `*What's your current fitness level?* 💪\n\nTap to select:`, FITNESS_LEVEL_KEYBOARD);
      return res.status(200).json({ ok: true });
    }

    if (user.onboarding_step !== "done") {
      await handleOnboarding(user, chatId, text);
    } else {
      await handleActiveUser(user, chatId, text);
    }
  } catch (err) {
    console.error("[webhook] ERROR: %s\n%s", err.message, err.stack);
    try {
      const chatId = message?.chat?.id ? String(message.chat.id) : null;
      if (chatId) await sendMessage(chatId, `Taking longer than expected...`);
    } catch (_) {}
  }

  res.status(200).json({ ok: true });
}
