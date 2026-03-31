/**
 * Gemini AI integration (default provider)
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export async function generateWeeklyPlanGemini(recentActivities, historyActivities, contextNotes, fitnessBackground) {
  const model = genai.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });
  const { buildPlanPrompt } = await import("./prompts.js");
  const result = await model.generateContent(buildPlanPrompt(recentActivities, historyActivities, contextNotes, fitnessBackground));
  return JSON.parse(result.response.text());
}

export async function answerQuestionGemini(question, plan, recentActivities, contextNotes) {
  const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
  const { buildQAPrompt } = await import("./prompts.js");
  const result = await model.generateContent(buildQAPrompt(question, plan, recentActivities, contextNotes));
  return result.response.text().trim();
}
