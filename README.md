# 🐦 Sparrow — AI Fitness Coach

Sparrow is an open-source AI fitness coach that lives in Telegram. It connects to your Strava account, builds a personalised weekly workout plan based on your training history, sends nightly reminders, and answers your fitness questions in real time.

**[talktosparrow.vercel.app](https://talktosparrow.vercel.app)** · **[@isparo_bot](https://t.me/isparo_bot)**

---

## Features

- **Weekly workout plans** — generated every Sunday at 8 PM IST based on your last 6 months of Strava data
- **Post-activity coaching** — after every completed workout, Sparrow sends a personalised coaching message comparing actual vs planned
- **Daily reminders** — every evening at 8 PM IST with tomorrow's session
- **Two-way coaching** — ask anything about your training, recovery, or goals
- **Strava integration** — real-time webhook syncs activities; fetches live data on Q&A
- **Smart plan management** — `/checkplan` detects drift between planned and actual workouts and regenerates only when needed
- **Exercise guide** — `/howto` gives form cues, coaching tips, and a YouTube link for any exercise
- **Guided onboarding** — collects fitness level, goals, days/week, limitations, and upcoming events via inline buttons
- **Pluggable AI** — defaults to Gemini (free); switch to Claude or GPT-4o mini with your own API key
- **Multi-user** — anyone with Telegram + Strava can use it
- **Feedback** — built-in issue reporting and feature requests from the landing page

---

## Stack

| Layer | Technology |
|---|---|
| Hosting | [Vercel](https://vercel.com) (serverless + cron) |
| Database | [Supabase](https://supabase.com) (PostgreSQL) |
| Messaging | [Telegram Bot API](https://core.telegram.org/bots/api) |
| Activity data | [Strava API](https://developers.strava.com) |
| AI (default) | [Google Gemini 2.5 Flash](https://ai.google.dev) |
| AI (optional) | [Anthropic Claude](https://console.anthropic.com) / [OpenAI](https://platform.openai.com) |

---

## Self-hosting

### Prerequisites

- [Vercel](https://vercel.com) account (Hobby is fine)
- [Supabase](https://supabase.com) project
- Telegram bot token — create one via [@BotFather](https://t.me/BotFather)
- Strava API application — [strava.com/settings/api](https://www.strava.com/settings/api)
- Gemini API key — [aistudio.google.com](https://aistudio.google.com) (free tier, create key in a new project without billing)

### 1. Clone & install

```bash
git clone https://github.com/eramishra/sparrow.git
cd sparrow
npm install
```

### 2. Set up Supabase

In your Supabase project, open the **SQL Editor** and run both files in order:

1. `supabase/schema.sql` — creates the three core tables
2. `supabase/migrations/add_llm_preference.sql` — adds per-user AI model columns

### 3. Configure environment variables

Copy the example and fill in your values:

```bash
cp .env.example .env.local
```

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | Any random string — used to verify webhook calls |
| `STRAVA_CLIENT_ID` | From [strava.com/settings/api](https://www.strava.com/settings/api) |
| `STRAVA_CLIENT_SECRET` | From [strava.com/settings/api](https://www.strava.com/settings/api) |
| `GEMINI_API_KEY` | From [aistudio.google.com](https://aistudio.google.com) |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase `service_role` key (Settings → API) |
| `APP_URL` | Your deployed Vercel URL, e.g. `https://talktosparrow.vercel.app` |
| `CRON_SECRET` | Any random string — used to secure cron endpoints |
| `RESEND_API_KEY` | From [resend.com](https://resend.com) — used to send feedback emails |

### 4. Deploy to Vercel

```bash
npm install -g vercel
vercel deploy --prod
```

Add all environment variables in the Vercel dashboard under **Project → Settings → Environment Variables**, or use `vercel env add`.

### 5. Register the Telegram webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR_APP_URL>/api/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 6. Set Strava callback domain

In [strava.com/settings/api](https://www.strava.com/settings/api), set the **Authorization Callback Domain** to your Vercel domain (without `https://`).

---

## Bot commands

**Plans**
| Command | Description |
|---|---|
| `/plan` | View this week's workout plan |
| `/newplan` | Generate a fresh plan starting from today |
| `/checkplan` | Check if your week has drifted; regenerates only if 2+ days diverged |

**Profile**
| Command | Description |
|---|---|
| `/profile` | View your fitness level, goals, training days, and saved context |
| `/update profile` | Update fitness level, goals, days/week, limitations, and targets |

**Exercise Guide**
| Command | Description |
|---|---|
| `/howto <exercise>` | Form cues, coaching tips, and a YouTube link for any exercise |

**Settings**
| Command | Description |
|---|---|
| `/connect` | Connect or reconnect your Strava account |
| `/llm` | Check which AI model is active |
| `/llm gemini` | Switch to Gemini 2.5 Flash (free, default) |
| `/llm claude <api_key>` | Switch to Claude Haiku |
| `/llm openai <api_key>` | Switch to GPT-4o mini |
| `/reset` | Clear your profile and restart onboarding |
| `/start` | Begin onboarding or see a welcome-back summary |
| `/help` | List all commands inside Telegram |

Any other message is sent to your AI coach as a question.

---

## Switching AI models

Sparrow ships with Gemini as the default (free, no billing required). You can switch per-user at any time.

### Claude (Anthropic)

1. Sign up at [console.anthropic.com](https://console.anthropic.com) and add billing credits
2. Go to **API Keys** → **Create Key**
3. Copy your key (starts with `sk-ant-`)
4. In Telegram: `/llm claude sk-ant-YOUR_KEY`

### OpenAI (GPT-4o mini)

1. Sign up at [platform.openai.com](https://platform.openai.com) and add billing credits
2. Go to **API keys** → **Create new secret key**
3. Copy your key (starts with `sk-`)
4. In Telegram: `/llm openai sk-YOUR_KEY`

> ⚠️ Delete the Telegram message after sending your API key to avoid it being visible in your chat history.

---

## Project structure

```
api/
  webhook.js          # Telegram webhook handler (commands + onboarding + Q&A)
  strava-webhook.js   # Strava real-time activity events + post-activity coaching
  strava-callback.js  # Strava OAuth callback
  feedback.js         # Feedback form email handler (Resend)
  cron/
    weekly-plan.js    # Sunday plan generation (cron)
    daily-reminder.js # Nightly reminders (cron)
src/
  ai.js               # AI router (Gemini / Claude / OpenAI)
  plan.js             # Plan generation, divergence detection, activity matching
  prompts.js          # Shared prompt builders
  strava.js           # Strava API client
  supabase.js         # Supabase DB helpers
  telegram.js         # Telegram Bot API client
supabase/
  schema.sql          # Database schema
  migrations/         # Schema migrations
scripts/
  test-cli.mjs        # Interactive terminal for testing AI responses
  register-strava-webhook.mjs  # One-time Strava webhook registration
public/
  index.html          # Landing page
```

---

## Local testing

A terminal REPL is included for testing AI responses without going through Telegram:

```bash
node scripts/test-cli.mjs
```

Loads your real Supabase data (user profile, plan, recent activities) and lets you ask questions, switch AI models, and override context — all from the terminal.

---

## License

[MIT](LICENSE) — Ankur Mishra
