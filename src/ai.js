/**
 * AI router — delegates to Gemini (default), Claude, or OpenAI based on user preference
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildPlanPrompt, buildQAPrompt } from "./prompts.js";

// ─── Gemini ────────────────────────────────────────────────────────────────

async function geminiPlan(recentActivities, historyActivities, contextNotes, fitnessBackground) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });
  const result = await model.generateContent(buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground));
  return JSON.parse(result.response.text());
}

async function geminiQA(question, plan, recentActivities, contextNotes) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(buildQAPrompt(question, plan, recentActivities, contextNotes));
  return result.response.text().trim();
}

// ─── Claude ────────────────────────────────────────────────────────────────

async function claudePlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground) }],
  });
  const text = message.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude did not return valid JSON");
  return JSON.parse(match[0]);
}

async function claudeQA(apiKey, question, plan, recentActivities, contextNotes) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{ role: "user", content: buildQAPrompt(question, plan, recentActivities, contextNotes) }],
  });
  return message.content[0].text.trim();
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

async function openaiPlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground) }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function openaiQA(apiKey, question, plan, recentActivities, contextNotes) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildQAPrompt(question, plan, recentActivities, contextNotes) }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function generateWeeklyPlan(recentActivities, historyActivities, contextNotes = "", fitnessBackground = "already_active", llmConfig = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  if (provider === "claude") return claudePlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground);
  if (provider === "openai") return openaiPlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground);
  return geminiPlan(recentActivities, historyActivities, contextNotes, fitnessBackground);
}

export async function answerQuestion(question, plan, recentActivities, contextNotes = "", llmConfig = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  if (provider === "claude") return claudeQA(apiKey, question, plan, recentActivities, contextNotes);
  if (provider === "openai") return openaiQA(apiKey, question, plan, recentActivities, contextNotes);
  return geminiQA(question, plan, recentActivities, contextNotes);
}
