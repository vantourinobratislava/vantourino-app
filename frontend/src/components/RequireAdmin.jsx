import { Navigate, useLocation } from 'react-router-dom';
import { useAdminAuth } from '../auth/AdminAuth.jsx';
import { Spinner } from './ui.jsx';

export function RequireAdmin({ children }) {
  const { admin, loading } = useAdminAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="page">
        <main className="page__main"><Spinner label="Loading…" /></main>
      </div>
    );
  }
  if (!admin) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}
