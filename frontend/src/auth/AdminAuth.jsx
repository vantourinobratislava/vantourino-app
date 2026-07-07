import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { adminApi, ApiError } from '../api/client.js';

const AdminAuthContext = createContext(null);

export function AdminAuthProvider({ children }) {
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);

  // Check existing session on mount (covers reloads while logged in).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await adminApi.me();
        if (!cancelled) setAdmin(me);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) {
          // unexpected; ignore for now, just leave admin=null
          console.warn('me() failed:', err);
        }
        if (!cancelled) setAdmin(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (username, password) => {
    // /login returns a thin DTO ({id, username, role}). Fetch /me right
    // after so the admin object carries effectivePermissions for the
    // frontend visibility helpers (Phase 1C-C). One extra round-trip on
    // login — cheap and keeps the change frontend-only.
    await adminApi.login(username, password);
    const me = await adminApi.me();
    setAdmin(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    try { await adminApi.logout(); } catch {/* best-effort */}
    setAdmin(null);
  }, []);

  // Permission helper used by tiles, route guards, and inline buttons.
  // Fail-closed: returns false when the admin or the key is missing.
  // For super_admin, the backend resolver fills effectivePermissions
  // with all-true, so this returns true for every key.
  const can = useCallback((key) => {
    if (!admin || !admin.effectivePermissions) return false;
    return !!admin.effectivePermissions[key];
  }, [admin]);

  return (
    <AdminAuthContext.Provider value={{ admin, loading, login, logout, can }}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be used inside <AdminAuthProvider>');
  return ctx;
}
