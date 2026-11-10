-- More than one daily log per project per date.
--
-- 001 created daily_logs with UNIQUE (project_id, log_date). Postgres names
-- that constraint daily_logs_project_id_log_date_key. A second insert on the
-- same date failed with 23505, which the API returned as 409. The UNIQUE
-- stays in 001 as the historical CREATE TABLE. This file is what an existing
-- database applies, including on every boot.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS and CREATE INDEX IF NOT EXISTS are
-- no-ops the second time. The index is not unique — a project manager may
-- log the morning and the afternoon.

SET search_path = projects, public;

ALTER TABLE projects.daily_logs
  DROP CONSTRAINT IF EXISTS daily_logs_project_id_log_date_key;

CREATE INDEX IF NOT EXISTS daily_logs_project_date_idx
  ON projects.daily_logs (project_id, log_date DESC, created_at DESC);
