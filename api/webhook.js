/**
 * Vercel serverless webhook handler
 * Receives Telegram messages and responds via Claude
 *
 * Supported messages:
 *   /update <text>  — appends text to context.md in the repo
 *   anything else   — answers the question using Claude + current plan + history
 */

import Anthropic from "@anthropic-ai/sdk";
import { answerQuestion } from "../src/claude.js";

const REPO = process.env.GH_REPO; // e.g. "eramishra/workout-bot"
const GH_API = "https://api.github.com";

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function getRepoFile(path) {
  const res = await fetch(`${GH_API}/repos/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_PAT}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (res.status === 404) return { content: "", sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const data = await res.json();
  return {
    content: Buffer.from(data.content, "base64").toString("utf8"),
    sha: data.sha,
  };
}

async function putRepoFile(path, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${GH_API}/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${process.env.GH_PAT}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
}

// ── Telegram helper ───────────────────────────────────────────────────────────

async function sendTelegramMessage(text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    }),
  });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleUpdate(updateText) {
  const { content, sha } = await getRepoFile("context.md");
  const timestamp = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
  const newContent = content + `\n- [${timestamp}] ${updateText}`;
  await putRepoFile("context.md", newContent.trim() + "\n", sha, `context: add update via Telegram`);
  await sendTelegramMessage(`Got it! Saved:\n_"${updateText}"_\n\nThis will be factored into your next weekly plan.`);
}

async function handleQuestion(question) {
  const [planFile, historyFile, contextFile] = await Promise.all([
    getRepoFile("plan.json"),
    getRepoFile("fitness-history.json"),
    getRepoFile("context.md"),
  ]);

  const plan = planFile.content ? JSON.parse(planFile.content) : null;
  const history = historyFile.content ? JSON.parse(historyFile.content) : { activities: [] };

  // Pass last 4 weeks of history for Q&A context (keeps prompt lean)
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const recentHistory = history.activities.filter((a) => a.startDateIso >= fourWeeksAgo);

  const answer = await answerQuestion(question, plan, recentHistory, contextFile.content);
  await sendTelegramMessage(answer);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== "POST") return res.status(405).end();

  // Validate Telegram webhook secret
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(403).end();

  try {
    const { message } = req.body;

    if (message?.text && String(message.chat.id) === process.env.TELEGRAM_CHAT_ID) {
      const text = message.text.trim();

      if (text.startsWith("/update ")) {
        await handleUpdate(text.slice(8).trim());
      } else if (text === "/start") {
        await sendTelegramMessage(
          "Hi! I'm your workout coach bot.\n\n" +
          "• Ask me anything about your plan\n" +
          "• Use `/update <text>` to save context (e.g. upcoming races, injuries)\n\n" +
          "_Examples:_\n" +
          "`/update I have a 10k race this Sunday`\n" +
          "`Should I rest tomorrow?`"
        );
      } else {
        await handleQuestion(text);
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  // Respond after all async work is done
  res.status(200).json({ ok: true });
}
