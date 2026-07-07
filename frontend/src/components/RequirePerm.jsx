import { Navigate } from 'react-router-dom';
import { useAdminAuth } from '../auth/AdminAuth.jsx';

/*
 * Page-level permission guard.
 *
 * Renders the children only if the current admin's effectivePermissions
 * include the named key. Otherwise redirects to a safe fallback
 * (default: /admin/menu) so deep links / bookmarks degrade gracefully
 * instead of showing a broken/empty page.
 *
 * MUST be used inside <RequireAdmin>, which guarantees `admin` is loaded
 * by the time we mount. With that outer guard in place, `admin` is never
 * null here and a single can(...) check is enough.
 *
 * Phase 1C-C: backend already enforces (Phase 1C-A); this component is
 * UX polish so users don't see surfaces they can't act on.
 */
export function RequirePerm({ permission, fallback = '/admin/menu', children }) {
  const { can } = useAdminAuth();
  if (!can(permission)) {
    return <Navigate to={fallback} replace />;
  }
  return children;
}

export default RequirePerm;
