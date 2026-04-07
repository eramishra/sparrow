/**
 * Telegram bot client — multi-user, accepts any chat_id
 * Set MOCK_TELEGRAM=true to print messages to console instead of calling the API.
 */

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

function isMock() { return process.env.MOCK_TELEGRAM === "true"; }
function mockMsg(fn, chatId, text) {
  console.log(`\n  [${fn}] → ${text ?? "(no text)"}`);
  return { ok: true, result: { message_id: Date.now() } };
}

function stripMarkdown(text) {
  return text.replace(/[*_`\[\]]/g, "");
}

export async function sendMessage(chatId, text) {
  if (isMock()) return mockMsg("sendMessage", chatId, text);
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Telegram parse error — retry as plain text
    if (res.status === 400 && body.includes("parse entities")) {
      const fallback = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: stripMarkdown(text) }),
      });
      if (!fallback.ok) throw new Error(`Telegram sendMessage failed: ${fallback.status} ${await fallback.text()}`);
      return fallback.json();
    }
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
  return res.json();
}

export async function sendMessageWithButtons(chatId, text, inlineKeyboard) {
  if (isMock()) return mockMsg("sendMessageWithButtons", chatId, text);
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessageWithButtons failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function editMessageText(chatId, messageId, text, inlineKeyboard) {
  if (isMock()) return mockMsg("editMessageText", chatId, text);
  const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
  });
  if (!res.ok) throw new Error(`Telegram editMessageText failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (isMock()) return { ok: true };
  const res = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
  if (!res.ok) throw new Error(`Telegram answerCallbackQuery failed: ${res.status} ${await res.text()}`);
  return res.json();
}
