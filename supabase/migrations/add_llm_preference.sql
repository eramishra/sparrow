-- Add per-user LLM preference
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_llm TEXT NOT NULL DEFAULT 'gemini';
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_api_key TEXT;
