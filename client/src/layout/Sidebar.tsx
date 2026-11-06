import { ChevronDown, FileClock, Mail, Plus, X } from "lucide-react";
import { NavLink, Link } from "react-router-dom";
import { useWorkspaceEmails } from "../hooks/useWorkspaceEmails";
import { useAuth } from "../context/AuthContext";

export function Sidebar({
  collapsed,
  mobileOpen,
  onCloseMobile,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { emails, loading, error } = useWorkspaceEmails();
  const { user } = useAuth();
  const count = (statuses: string[]) => error ? "—" : loading
    ? "…"
    : emails.filter((email) => statuses.includes(email.status)).length;

  return (
    <>
      {mobileOpen && (
        <button className="mobile-scrim" aria-label="Close navigation" onClick={onCloseMobile} />
      )}
      <aside className={`sidebar inbox-sidebar ${collapsed ? "sidebar-collapsed" : ""} ${mobileOpen ? "sidebar-mobile-open" : ""}`}>
        <div className="brand-row inbox-brand">
          <Link className="brand-name inbox-wordmark" to="/scheduled" aria-label="ReachInbox home">
            <span className="pixel-mark" aria-hidden="true">R</span>
            <span>reachinbox</span>
          </Link>
          <button className="sidebar-close icon-button" aria-label="Close navigation" onClick={onCloseMobile}>
            <X size={17} />
          </button>
        </div>
        <div className="profile-card">
          {user?.avatarUrl ? <img className="profile-avatar" src={user.avatarUrl} alt="" /> : <div className="profile-avatar" aria-hidden="true">{user?.name.slice(0, 1).toUpperCase()}</div>}
          <div className="profile-copy">
            <strong>{user?.name}</strong>
            <span>{user?.email}</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <Link className="compose-link" to="/compose" onClick={onCloseMobile}>
          <Plus size={16} /> Compose
        </Link>
        <div className="nav-section-label">CORE</div>
        <nav className="side-nav" aria-label="Email folders">
          <NavLink to="/scheduled" className={({ isActive }) => `nav-link inbox-nav-link ${isActive ? "nav-link-active" : ""}`} onClick={onCloseMobile}>
            <FileClock size={16} /><span>Scheduled</span><span className="nav-count">{count(["pending", "queued", "processing"])}</span>
          </NavLink>
          <NavLink to="/sent" className={({ isActive }) => `nav-link inbox-nav-link ${isActive ? "nav-link-active" : ""}`} onClick={onCloseMobile}>
            <Mail size={16} /><span>Sent</span><span className="nav-count">{count(["sent", "failed"])}</span>
          </NavLink>
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-footnote">LOCAL DEVELOPMENT WORKSPACE</div>
      </aside>
    </>
  );
}
