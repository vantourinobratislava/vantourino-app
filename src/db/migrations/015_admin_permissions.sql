-- 015_admin_permissions.sql
-- Phase 1C-A: per-admin permission overrides on top of role.
--
-- Additive. NULL means "use the role baseline" so existing rows continue
-- behaving exactly as their role implies. The current main super_admin
-- stays NULL and effectively gets all-true via the role default map.
--
-- The schema is intentionally just a JSON blob: extensible without
-- migrations, fits a small RBAC matrix, easy to audit by dumping the row.
-- The service validates against a canonical key allowlist; unknown keys
-- can't be persisted via the admin API.

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT NULL;
