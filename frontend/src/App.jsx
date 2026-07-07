import { Routes, Route, Navigate } from 'react-router-dom';
import { AdminAuthProvider } from './auth/AdminAuth.jsx';
import { RequireAdmin } from './components/RequireAdmin.jsx';
import { RequirePerm } from './components/RequirePerm.jsx';

// Admin pages
import AdminLogin from './pages/admin/AdminLogin.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import MainMenu from './pages/admin/MainMenu.jsx';
import UsersPage from './pages/admin/UsersPage.jsx';
import RulesPage from './pages/RulesPage.jsx';
import SirupsPage from './pages/SirupsPage.jsx';
import RidesPage from './pages/RidesPage.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import AudioguidesPage from './pages/AudioguidesPage.jsx';
import CreateQuiz from './pages/admin/CreateQuiz.jsx';
import QuizList from './pages/admin/QuizList.jsx';
import ImportQuiz from './pages/admin/ImportQuiz.jsx';
import EditQuiz from './pages/admin/EditQuiz.jsx';
import QuizQuestions from './pages/admin/QuizQuestions.jsx';
import CreateSession from './pages/admin/CreateSession.jsx';
import SessionControl from './pages/admin/SessionControl.jsx';
import SessionHistory from './pages/admin/SessionHistory.jsx';
import SessionSummary from './pages/admin/SessionSummary.jsx';

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
        <Route path="/admin/menu" element={<RequireAdmin><MainMenu /></RequireAdmin>} />
        <Route path="/admin/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
        <Route path="/admin/calendar" element={<RequireAdmin><RequirePerm permission="calendar"><CalendarPage /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/rides" element={<RequireAdmin><RequirePerm permission="rides"><RidesPage /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/rules" element={<RequireAdmin><RequirePerm permission="rules"><RulesPage /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/sirups" element={<RequireAdmin><RequirePerm permission="sirups"><SirupsPage /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/audioguides" element={<RequireAdmin><RequirePerm permission="audioguides"><AudioguidesPage /></RequirePerm></RequireAdmin>} />
        <Route path="/admin" element={<RequireAdmin><RequirePerm permission="challenges"><AdminDashboard /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/quizzes" element={<RequireAdmin><RequirePerm permission="challenges.manage_quizzes"><QuizList /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/quizzes/import" element={<RequireAdmin><RequirePerm permission="challenges.create_quiz"><ImportQuiz /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/quizzes/new" element={<RequireAdmin><RequirePerm permission="challenges.create_quiz"><CreateQuiz /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/quizzes/:quizId/edit" element={<RequireAdmin><RequirePerm permission="challenges.manage_quizzes"><EditQuiz /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/quizzes/:quizId" element={<RequireAdmin><RequirePerm permission="challenges.manage_quizzes"><QuizQuestions /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/sessions" element={<RequireAdmin><RequirePerm permission="challenges.session_history"><SessionHistory /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/sessions/new" element={<RequireAdmin><RequirePerm permission="challenges"><CreateSession /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/sessions/:sessionCode/summary" element={<RequireAdmin><RequirePerm permission="challenges.session_history"><SessionSummary /></RequirePerm></RequireAdmin>} />
        <Route path="/admin/sessions/:sessionCode" element={<RequireAdmin><RequirePerm permission="challenges"><SessionControl /></RequirePerm></RequireAdmin>} />

        {/* Team (public) */}
        <Route path="/join/:sessionCode" element={<TeamJoin />} />
        <Route path="/play/:sessionCode" element={<TeamSession />} />

        {/* Public module pages (read-only views) */}
        <Route path="/rules" element={<RulesPage readOnly />} />
        <Route path="/sirups" element={<SirupsPage readOnly />} />
        <Route path="/calendar" element={<CalendarPage readOnly />} />
        <Route path="/rides" element={<RidesPage readOnly />} />
        <Route path="/audioguides" element={<AudioguidesPage readOnly />} />

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
