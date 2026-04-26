import { Routes, Route, Navigate } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth-context';
import LoginPage from './pages/LoginPage';
import DashboardLayout from './pages/DashboardLayout';
import HomePage from './pages/HomePage';
import ChatPage from './pages/ChatPage';
import SessionsPage from './pages/SessionsPage';
import AgentsPage from './pages/AgentsPage';
import NewProjectPage from './pages/NewProjectPage';
import ProjectLayout from './pages/ProjectLayout';
import ProjectChatPage from './pages/ProjectChatPage';
import ProjectSessionsPage from './pages/ProjectSessionsPage';
import ProjectSkillsPage from './pages/ProjectSkillsPage';
import ProjectSettingsPage from './pages/ProjectSettingsPage';
import AdminPage from './pages/AdminPage';
import AdminSessionsPage from './pages/AdminSessionsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
          <Route index element={<HomePage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="projects/new" element={<NewProjectPage />} />
          <Route path="projects/:id" element={<ProjectLayout />}>
            <Route path="chat" element={<ProjectChatPage />} />
            <Route path="sessions" element={<ProjectSessionsPage />} />
            <Route path="skills" element={<ProjectSkillsPage />} />
            <Route path="settings" element={<ProjectSettingsPage />} />
          </Route>
          <Route path="admin" element={<AdminRoute><AdminPage /></AdminRoute>} />
          <Route path="admin/sessions" element={<AdminRoute><AdminSessionsPage /></AdminRoute>} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
