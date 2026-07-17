import { Routes, Route, Navigate, useParams } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth-context';
import { AutomationProvider } from './lib/automation-context';
import { SplitProvider } from './lib/split-context';
import { useProjectContextOptional } from './lib/project-context';
import LoginPage from './pages/LoginPage';
import DashboardLayout from './pages/DashboardLayout';
import HomePage from './pages/HomePage';
import ChatPage from './pages/ChatPage';
import SessionsPage from './pages/SessionsPage';
import AgentsPage from './pages/AgentsPage';
import NewProjectPage from './pages/NewProjectPage';
import ProjectLayout from './pages/ProjectLayout';
import KeepAliveChat from './components/KeepAliveChat';
import ProjectSkillsPage from './pages/ProjectSkillsPage';
import ProjectSettingsPage from './pages/ProjectSettingsPage';
import ProjectBoardPage from './pages/ProjectBoardPage';
import ProjectMilestonesPage from './pages/ProjectMilestonesPage';
import ProjectIssuesPage from './pages/ProjectIssuesPage';
import ProjectPullsPage from './pages/ProjectPullsPage';
import WorktreeLayout from './pages/WorktreeLayout';
import WorktreeChatPage from './pages/WorktreeChatPage';
import AdminPage from './pages/AdminPage';
import AdminSessionsPage from './pages/AdminSessionsPage';
import AdminDaemonPage from './pages/AdminDaemonPage';
import SchedulesPage from './pages/SchedulesPage';
import ScheduleRunsPage from './pages/ScheduleRunsPage';
import ReportViewerPage from './pages/ReportViewerPage';
import AutomationHistoryPage from './pages/AutomationHistoryPage';
import { Toaster } from './components/ui/sonner';
import { useReportNotifications } from './hooks/useReportNotifications';

/** Uses KeepAliveChat to keep recently-used project terminals alive across switches */
function ProjectChatKeepAlive() {
  const { id } = useParams<{ id: string }>();
  const ctx = useProjectContextOptional();
  return <KeepAliveChat projectId={id} cwd={ctx?.cwd} />;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function ReportNotificationListener() {
  useReportNotifications();
  return null;
}

export function App() {
  return (
    <AuthProvider>
      <AutomationProvider>
        <Toaster />
        <ReportNotificationListener />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute><SplitProvider><DashboardLayout /></SplitProvider></ProtectedRoute>}>
            <Route index element={<HomePage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="projects/new" element={<NewProjectPage />} />
            <Route path="projects/:id" element={<ProjectLayout />}>
              <Route index element={<Navigate to="chat" replace />} />
              <Route path="chat" element={<ProjectChatKeepAlive />} />
              <Route path="board" element={<ProjectBoardPage />} />
              <Route path="milestones" element={<ProjectMilestonesPage />} />
              <Route path="issues" element={<ProjectIssuesPage />} />
              <Route path="pulls" element={<ProjectPullsPage />} />
              <Route path="skills" element={<ProjectSkillsPage />} />
              <Route path="settings" element={<ProjectSettingsPage />} />
            </Route>
            <Route path="projects/:id/worktrees/:worktreeId" element={<WorktreeLayout />}>
              <Route index element={<Navigate to="chat" replace />} />
              <Route path="chat" element={<WorktreeChatPage />} />
            </Route>
            <Route path="automation" element={<AutomationHistoryPage />} />
            <Route path="automation/config" element={<SchedulesPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="admin/sessions" element={<AdminSessionsPage />} />
            <Route path="admin/schedules" element={<Navigate to="/automation/config" replace />} />
            <Route path="admin/schedules/:id/runs" element={<ScheduleRunsPage />} />
            <Route path="admin/reports/:id" element={<ReportViewerPage />} />
            <Route path="daemon" element={<AdminDaemonPage />} />
          </Route>
        </Routes>
      </AutomationProvider>
    </AuthProvider>
  );
}
