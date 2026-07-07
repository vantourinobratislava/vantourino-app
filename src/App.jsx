import { Routes, Route, Navigate } from 'react-router-dom';
import { AdminAuthProvider } from './auth/AdminAuth.jsx';
import { RequireAdmin } from './components/RequireAdmin.jsx';

// Admin pages
import AdminLogin from './pages/admin/AdminLogin.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import CreateQuiz from './pages/admin/CreateQuiz.jsx';
import QuizList from './pages/admin/QuizList.jsx';
import EditQuiz from './pages/admin/EditQuiz.jsx';
import QuizQuestions from './pages/admin/QuizQuestions.jsx';
import CreateSession from './pages/admin/CreateSession.jsx';
import SessionControl from './pages/admin/SessionControl.jsx';

// Public pages
import TeamJoin from './pages/public/TeamJoin.jsx';
import TeamSession from './pages/public/TeamSession.jsx';

// Public landing — directs people based on what kind of user they are.
import Landing from './pages/Landing.jsx';

export default function App() {
  return (
    <AdminAuthProvider>
      <Routes>
        <Route path="/" element={<Landing />} />

        {/* Admin */}
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<RequireAdmin><AdminDashboard /></RequireAdmin>} />
        <Route path="/admin/quizzes" element={<RequireAdmin><QuizList /></RequireAdmin>} />
        <Route path="/admin/quizzes/new" element={<RequireAdmin><CreateQuiz /></RequireAdmin>} />
        <Route path="/admin/quizzes/:quizId/edit" element={<RequireAdmin><EditQuiz /></RequireAdmin>} />
        <Route path="/admin/quizzes/:quizId" element={<RequireAdmin><QuizQuestions /></RequireAdmin>} />
        <Route path="/admin/sessions/new" element={<RequireAdmin><CreateSession /></RequireAdmin>} />
        <Route path="/admin/sessions/:sessionCode" element={<RequireAdmin><SessionControl /></RequireAdmin>} />

        {/* Team (public) */}
        <Route path="/join/:sessionCode" element={<TeamJoin />} />
        <Route path="/play/:sessionCode" element={<TeamSession />} />

        {/* Aliases / fallthroughs */}
        <Route path="/s/:sessionCode" element={<NavigateToJoin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AdminAuthProvider>
  );
}

// `import { useParams } from 'react-router-dom'` would be needed inline,
// so we factor this into a tiny component.
import { useParams } from 'react-router-dom';
function NavigateToJoin() {
  const { sessionCode } = useParams();
  return <Navigate to={`/join/${sessionCode}`} replace />;
}
