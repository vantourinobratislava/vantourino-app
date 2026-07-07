-- 013_rides.sql
-- Rides module Phase 1: a simple admin-managed list of scheduled rides for
-- today's operational overview. Manually maintained; no external sync yet.
--
-- Date and time are stored separately (not as a single TIMESTAMPTZ) because
-- a ride's date is calendar-day semantics ("rides on Saturday"), not an
-- instant in time. The server and admin operate in the same operational TZ
-- (Bratislava local), so "today" via CURRENT_DATE matches what the operator
-- sees. This also avoids accidental TZ shifts on display.
--
-- Future phases will extend this with optional WP-sync fields (external_id,
-- source), guide assignment, etc. — all addable as nullable columns without
-- disturbing Phase-1 rows.

CREATE TABLE IF NOT EXISTS rides (
  id           SERIAL PRIMARY KEY,
  ride_date    DATE         NOT NULL,
  start_time   TIME         NOT NULL,
  title        VARCHAR(255) NOT NULL,
  guest_count  INTEGER      NOT NULL DEFAULT 0,
  notes        TEXT,
  status       VARCHAR(20)  NOT NULL DEFAULT 'scheduled',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Non-negative guest count guard. Cheap data hygiene, not a business rule.
ALTER TABLE rides DROP CONSTRAINT IF EXISTS chk_rides_guest_count;
ALTER TABLE rides
  ADD CONSTRAINT chk_rides_guest_count CHECK (guest_count >= 0);

-- Allowed statuses. Extensible later — relaxing a CHECK is a non-breaking
-- change since existing rows already satisfy the wider set.
ALTER TABLE rides DROP CONSTRAINT IF EXISTS chk_rides_status;
ALTER TABLE rides
  ADD CONSTRAINT chk_rides_status
  CHECK (status IN ('scheduled', 'completed', 'cancelled'));

-- Dominant query: list by when they happen.
CREATE INDEX IF NOT EXISTS idx_rides_date_time ON rides (ride_date, start_time);
