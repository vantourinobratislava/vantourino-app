-- 016_admins_crew_external_id.sql
--
-- Crew claiming (Calendar) — manual identity link between an app admin and
-- a WordPress crew member record.
--
-- `crew_external_id` holds the WordPress crew member's stable `external_id`.
-- The app does NOT generate this value: super_admin pastes the matching WP
-- external_id on the Users management page to pair an admin with a crew
-- member. It is PUBLIC (safe to appear in a WP booking's crew_*_external_id
-- field) and is NOT a credential — auth stays the app session plus the
-- server-side app↔WP bearer token.
--
-- Nullable: an unpaired admin has NULL here and simply cannot claim crew
-- slots until super_admin sets the value.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS crew_external_id VARCHAR(64);

-- Fast lookup when resolving an external id (e.g. collision checks).
-- Not UNIQUE at the DB level: many rows are legitimately NULL (unpaired),
-- and a hard uniqueness constraint could wedge a legitimate correction.
CREATE INDEX IF NOT EXISTS idx_admins_crew_external_id ON admins (crew_external_id);
