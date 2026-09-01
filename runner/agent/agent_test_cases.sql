-- Agent-authored test cases live in their OWN table, separate from the
-- production test_cases table. This keeps AI drafts isolated: review, run,
-- delete, or "promote" them into test_cases without ever polluting the real
-- suite. Strictly additive — does not touch any existing table.
--
-- Apply once:  psql -h 172.19.2.5 -U appuser -d automation_db -f agent_test_cases.sql

CREATE TABLE IF NOT EXISTS agent_test_cases (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER,                       -- which project it belongs to (for UI filtering / run)
  name          VARCHAR(255) NOT NULL,
  goal          TEXT,                          -- the natural-language goal the agent was given
  base_url      VARCHAR(500),
  type          VARCHAR(32)  DEFAULT 'ui',
  browser       VARCHAR(32)  DEFAULT 'chrome',
  steps         JSONB        NOT NULL DEFAULT '[]',   -- runner-format steps, same shape as test_cases.steps
  variables     JSONB        DEFAULT '[]',
  source        VARCHAR(32)  DEFAULT 'agent',  -- always 'agent' here
  status        VARCHAR(32)  DEFAULT 'draft',  -- draft | reviewed | promoted
  approved      BOOLEAN      DEFAULT FALSE,     -- a human has reviewed it
  promoted_test_case_id INTEGER,               -- if promoted into test_cases, the new id
  created_by    INTEGER,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_test_cases_project ON agent_test_cases(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_test_cases_created ON agent_test_cases(created_at DESC);
