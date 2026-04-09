/**
 * AI router — delegates to Gemini (default), Claude, or OpenAI based on user preference
 * All public functions return { text, usage } or { ...planFields, usage }
 * usage: { inputTokens, outputTokens, model, provider }
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildPlanPrompt, buildQAPrompt, buildHowToPrompt, buildActivityFeedbackPrompt } from "./prompts.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function isOverloaded(err) {
  const msg = err.message?.toLowerCase() ?? "";
  return msg.includes("503") || msg.includes("529") || msg.includes("overloaded") || msg.includes("high demand");
}

async function withRetry(fn, maxAttempts = 3, delayMs = 4000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isOverloaded(err) && attempt < maxAttempts) {
        console.warn(`[ai] Overloaded (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
      } else {
        throw err;
      }
    }
  }
}

// ─── Gemini ────────────────────────────────────────────────────────────────

async function geminiPlan(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });
  const result = await model.generateContent(buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile));
  const meta = result.response.usageMetadata;
  return {
    data: JSON.parse(result.response.text()),
    usage: { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0, model: "gemini-2.5-flash", provider: "gemini" },
  };
}

async function geminiQA(question, plan, recentActivities, contextNotes, userProfile) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(buildQAPrompt(question, plan, recentActivities, contextNotes, userProfile));
  const meta = result.response.usageMetadata;
  return {
    text: result.response.text().trim(),
    usage: { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0, model: "gemini-2.5-flash", provider: "gemini" },
  };
}

// ─── Claude ────────────────────────────────────────────────────────────────

async function claudePlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile) }],
  });
  const text = message.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude did not return valid JSON");
  return {
    data: JSON.parse(match[0]),
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, model: "claude-haiku-4-5-20251001", provider: "claude" },
  };
}

async function claudeQA(apiKey, question, plan, recentActivities, contextNotes, userProfile) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{ role: "user", content: buildQAPrompt(question, plan, recentActivities, contextNotes, userProfile) }],
  });
  return {
    text: message.content[0].text.trim(),
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, model: "claude-haiku-4-5-20251001", provider: "claude" },
  };
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
  return {
    data: JSON.parse(data.choices[0].message.content),
    usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, model: "gpt-4o-mini", provider: "openai" },
  };
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
  return {
    text: data.choices[0].message.content.trim(),
    usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, model: "gpt-4o-mini", provider: "openai" },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function generateWeeklyPlan(recentActivities, historyActivities, contextNotes = "", fitnessBackground = "already_active", llmConfig = {}, startDate = null, userProfile = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  const result = await withRetry(() => {
    if (provider === "claude") return claudePlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile);
    if (provider === "openai") return openaiPlan(apiKey, recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile);
    return geminiPlan(recentActivities, historyActivities, contextNotes, fitnessBackground, startDate, userProfile);
  });
  return { ...result.data, usage: result.usage };
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
    return { text: message.content[0].text.trim(), usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, model: "claude-haiku-4-5-20251001", provider: "claude" } };
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { text: data.choices[0].message.content.trim(), usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, model: "gpt-4o-mini", provider: "openai" } };
  }

  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  const meta = result.response.usageMetadata;
  return { text: result.response.text().trim(), usage: { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0, model: "gemini-2.5-flash", provider: "gemini" } };
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
    return { text: message.content[0].text.trim(), usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, model: "claude-haiku-4-5-20251001", provider: "claude" } };
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { text: data.choices[0].message.content.trim(), usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, model: "gpt-4o-mini", provider: "openai" } };
  }

  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  const meta = result.response.usageMetadata;
  return { text: result.response.text().trim(), usage: { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0, model: "gemini-2.5-flash", provider: "gemini" } };
}

export async function answerQuestion(question, plan, recentActivities, contextNotes = "", llmConfig = {}, userProfile = {}) {
  const { provider = "gemini", apiKey } = llmConfig;
  if (provider === "claude") return claudeQA(apiKey, question, plan, recentActivities, contextNotes, userProfile);
  if (provider === "openai") return openaiQA(apiKey, question, plan, recentActivities, contextNotes, userProfile);
  return geminiQA(question, plan, recentActivities, contextNotes, userProfile);
}
