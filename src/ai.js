/**
 * AI router — delegates to Gemini (default), Claude, or OpenAI based on user preference
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildPlanPrompt, buildQAPrompt, buildHowToPrompt, buildActivityFeedbackPrompt } from "./prompts.js";

// ─── Gemini ────────────────────────────────────────────────────────────────

async function geminiPlan(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });
  const result = await model.generateContent(buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile));
  return JSON.parse(result.response.text());
}

async function geminiQA(question, plan, recentActivities, contextNotes, userProfile) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(buildQAPrompt(question, plan, recentActivities, contextNotes, userProfile));
  return result.response.text().trim();
}

// ─── Claude ────────────────────────────────────────────────────────────────

async function claudePlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) }],
  });
  const text = message.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude did not return valid JSON");
  return JSON.parse(match[0]);
}

async function claudeQA(apiKey, question, plan, recentActivities, contextNotes, userProfile) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{ role: "user", content: buildQAPrompt(question, plan, recentActivities, contextNotes, userProfile) }],
  });
  return message.content[0].text.trim();
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

async function openaiPlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function openaiQA(apiKey, question, plan, recentActivities, contextNotes, userProfile) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildQAPrompt(question, plan, recentActivities, contextNotes, userProfile) }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function generateWeeklyPlan(recentActivities, historyActivities, contextNotes = "", fitnessBackground = "already_active", llmConfig = {}, startDate = null, userProfile = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  if (provider === "claude") return claudePlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile);
  if (provider === "openai") return openaiPlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile);
  return geminiPlan(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile);
}

export async function explainExercise(exercise, llmConfig = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  const prompt = buildHowToPrompt(exercise);

  if (provider === "claude") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    return message.content[0].text.trim();
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
  }

  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

export async function generateActivityFeedback(activity, plannedDay, llmConfig = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  const prompt = buildActivityFeedbackPrompt(activity, plannedDay);

  if (provider === "claude") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });
    return message.content[0].text.trim();
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
  }

  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

export async function answerQuestion(question, plan, recentActivities, contextNotes = "", llmConfig = {}, userProfile = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  if (provider === "claude") return claudeQA(apiKey, question, plan, recentActivities, contextNotes, userProfile);
  if (provider === "openai") return openaiQA(apiKey, question, plan, recentActivities, contextNotes, userProfile);
  return geminiQA(question, plan, recentActivities, contextNotes, userProfile);
}
