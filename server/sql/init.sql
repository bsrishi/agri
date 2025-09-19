-- init.sql
-- Sri Lakshmi Agro - full schema bootstrap (idempotent)

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

/* ---------------- Helpers ---------------- */
-- Touch updated_at on UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

/* ---------------- Users ---------------- */
CREATE TABLE IF NOT EXISTS users (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE
);

-- Seed default users
INSERT INTO users (name, phone) VALUES
  ('Prakash', '6369176259'),
  ('Ranjith', '7904576602'),
  ('Rishi',   '9894064306')
ON CONFLICT (phone) DO NOTHING;

/* ---------------- Applications cache ----------------
   NOTE:
   - application_id is the only strict unique key
   - mobile / aadhaar are nullable (many apps can share same mobile/aadhaar)
   - keep both numeric areas
   - we normalize survey numbers into a separate table below
-----------------------------------------------------*/
CREATE TABLE IF NOT EXISTS applications (
  application_id  TEXT PRIMARY KEY,
  crop_type       TEXT,
  mi_name         TEXT,
  applied_date    TEXT,          -- raw as given by TN
  farmer_name     TEXT,
  mi_area         NUMERIC,
  total_area      NUMERIC,
  survey_no       TEXT,          -- original raw string from TN for display/debug
  subdivision_no  TEXT,
  farmer_type     TEXT,
  ss              TEXT,          -- last summary/status from listing row
  source          TEXT NOT NULL, -- "number" | "application" | etc.
  mobile          TEXT,          -- 10-digit normalized (nullable)
  aadhaar         TEXT,          -- 12-digit normalized (nullable)
  district       TEXT,
  block          TEXT,
  village        TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- If you’re migrating from an older dump:
-- Ensure mobile/aadhaar columns exist (no-ops if already there)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS mobile  TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS aadhaar TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS district TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS block    TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS village  TEXT;

-- You may have this from very early versions; keep it if present, but we no longer rely on it
-- (do NOT enforce NOT NULL on legacy key_value)
-- ALTER TABLE applications DROP COLUMN IF EXISTS key_value;  -- Uncomment only if you are done with legacy data

-- Useful indexes (non-unique, because many apps share same number)
CREATE INDEX IF NOT EXISTS idx_applications_mobile       ON applications (mobile);
CREATE INDEX IF NOT EXISTS idx_applications_aadhaar      ON applications (aadhaar);
CREATE INDEX IF NOT EXISTS idx_applications_updated_at   ON applications (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_farmer       ON applications (farmer_name);

-- Old composite index no longer needed after key_value removal
DROP INDEX IF EXISTS idx_applications_source_key;

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trg_applications_updated ON applications;
CREATE TRIGGER trg_applications_updated
BEFORE UPDATE ON applications
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* ------------- Normalized surveys per application -------------
   Used for per-survey eligibility logic (e.g., "Svy 362/3" vs "Svy 363/3")
----------------------------------------------------------------*/
CREATE TABLE IF NOT EXISTS application_surveys (
  id              BIGSERIAL PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
  survey_no       TEXT NOT NULL,  -- e.g., '362/3'
  subdivision_no  TEXT,           -- keep if you need a separate field
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (application_id, survey_no, subdivision_no)
);

CREATE INDEX IF NOT EXISTS idx_app_surveys_app     ON application_surveys (application_id);
CREATE INDEX IF NOT EXISTS idx_app_surveys_svy     ON application_surveys (survey_no);

DROP TRIGGER IF EXISTS trg_app_surveys_updated ON application_surveys;
CREATE TRIGGER trg_app_surveys_updated
BEFORE UPDATE ON application_surveys
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* ---------------- Status timeline ----------------
   We store status_date as a timestamptz for accurate sorting and traceability.
---------------------------------------------------*/
CREATE TABLE IF NOT EXISTS statuses (
  id               BIGSERIAL PRIMARY KEY,
  application_id   TEXT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
  status_date      TIMESTAMPTZ,   -- status date and time with timezone
  status           TEXT,
  remarks          TEXT,
  components       TEXT,
  name             TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE statuses DROP COLUMN IF EXISTS status_date_raw;
ALTER TABLE statuses DROP COLUMN IF EXISTS status_date_ts;

-- Ensure status_date column exists (no-ops if already there)
ALTER TABLE statuses ADD COLUMN IF NOT EXISTS status_date TIMESTAMPTZ;

-- Helpful indexes for fast "latest first" per application
CREATE INDEX IF NOT EXISTS idx_statuses_app_ts_desc ON statuses (application_id, status_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_statuses_app_id      ON statuses (application_id);

/* ---------------- Bulk processing (server-side jobs) ----------------
   Lets jobs continue even if the user closes the tab, and provide shared progress.
---------------------------------------------------------------------*/
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by TEXT,                 -- name of user who created the job
  total      INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  ok         INTEGER NOT NULL DEFAULT 0,
  error      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'done' | 'failed'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_bulk_jobs_updated ON bulk_jobs;
CREATE TRIGGER trg_bulk_jobs_updated
BEFORE UPDATE ON bulk_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS bulk_job_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES bulk_jobs(id) ON DELETE CASCADE,
  number     TEXT NOT NULL,        -- raw input (after our normalization on server)
  kind       TEXT,                 -- 'mobile' | 'aadhaar' | 'unknown'
  state      TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'fetching' | 'cached' | 'merged' | 'fetched' | 'skipped' | 'error'
  message    TEXT,                 -- e.g., "Already available locally", "Fetching from Government...", "Merged with existing data"
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_items_job           ON bulk_job_items (job_id);
CREATE INDEX IF NOT EXISTS idx_bulk_items_job_state     ON bulk_job_items (job_id, state);

DROP TRIGGER IF EXISTS trg_bulk_job_items_updated ON bulk_job_items;
CREATE TRIGGER trg_bulk_job_items_updated
BEFORE UPDATE ON bulk_job_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* ---------------- Optional views (for convenience) ---------------- */
-- Latest known status per application (by status_date desc, then created_at)
DROP VIEW IF EXISTS v_application_latest_status;
CREATE OR REPLACE VIEW v_application_latest_status AS
SELECT DISTINCT ON (s.application_id)
  s.application_id,
  s.status,
  s.remarks,
  s.components,
  s.name,
  s.status_date
FROM statuses s
ORDER BY s.application_id, s.status_date DESC NULLS LAST, s.id DESC;