-- 014_admin_roles.sql
-- Multi-admin / RBAC Phase 1A: add role + is_active to the existing admins
-- table. Purely additive; the existing single-admin setup keeps working
-- because:
--   - role defaults to 'super_admin', so the seeded admin gets full rights.
--   - is_active defaults to TRUE; nothing changes for existing rows.
--   - No other behavior change in this phase — Phase 1B will add role
--     enforcement on write endpoints, Phase 1C adds the user management UI.

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'super_admin';

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- The role ladder. Phase 1B will enforce minimums per route; extending the
-- set is then just a CHECK relax + service constant.
ALTER TABLE admins DROP CONSTRAINT IF EXISTS chk_admins_role;
ALTER TABLE admins
  ADD CONSTRAINT chk_admins_role
  CHECK (role IN ('super_admin', 'manager', 'operator', 'viewer'));

-- updated_at for auditing later. Cheap to add now.
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_admins_role ON admins (role);
