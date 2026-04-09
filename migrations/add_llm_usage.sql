CREATE TABLE IF NOT EXISTS llm_usage (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  call_type     text NOT NULL,  -- 'plan', 'qa', 'feedback', 'howto'
  provider      text NOT NULL,  -- 'gemini', 'claude', 'openai'
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_user_id   ON llm_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage(created_at);
