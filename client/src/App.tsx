import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DashboardLayout } from "./layout/DashboardLayout";
import Campaigns from "./pages/Campaigns";
import Compose from "./pages/Compose";
import EmailDetail from "./pages/EmailDetail";
import Leads from "./pages/Leads";
import Login from "./pages/Login";
import QueueMonitor from "./pages/QueueMonitor";
import ScheduledEmails from "./pages/ScheduledEmails";
import SearchEmails from "./pages/SearchEmails";
import SentEmails from "./pages/SentEmails";
import Settings from "./pages/Settings";
import { LoadingState } from "./components/ui";

export default function App() {
  return <AuthProvider><AuthenticatedRoutes /></AuthProvider>;
}

function AuthenticatedRoutes() {
  const { status, error, refresh } = useAuth();

  if (status === "loading") {
    return <main className="auth-loading"><LoadingState label="Checking your session…" /></main>;
  }
  if (status === "error") {
    return (
      <main className="auth-loading">
        <div className="auth-error" role="alert">
          <strong>Could not check your session</strong>
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()}>Try again</button>
        </div>
      </main>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={status === "authenticated" ? <Navigate to="/scheduled" replace /> : <Login />} />
      <Route
        path="*"
        element={
          status === "unauthenticated" ? <Navigate to="/login" replace /> : (
            <DashboardLayout>
              <Routes>
                <Route path="/" element={<Navigate to="/scheduled" replace />} />
                <Route path="/scheduled" element={<ScheduledEmails />} />
                <Route path="/sent" element={<SentEmails />} />
                <Route path="/compose" element={<Compose />} />
                <Route path="/email/:id" element={<EmailDetail />} />
                <Route path="/campaigns" element={<Campaigns />} />
                <Route path="/leads" element={<Leads />} />
                <Route path="/search" element={<SearchEmails />} />
                <Route path="/queue" element={<QueueMonitor />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/scheduled" replace />} />
              </Routes>
            </DashboardLayout>
          )
        }
      />
    </Routes>
  );
}
