import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { WorkspaceEmailsProvider } from "../hooks/useWorkspaceEmails";

export function DashboardLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    window.matchMedia("(max-width: 800px)").matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 800px)");
    const updateLayout = () => {
      setIsMobile(mediaQuery.matches);
      if (mediaQuery.matches) {
        setCollapsed(false);
      } else {
        setMobileOpen(false);
      }
    };

    mediaQuery.addEventListener("change", updateLayout);
    return () => mediaQuery.removeEventListener("change", updateLayout);
  }, []);

  return (
    <WorkspaceEmailsProvider>
      <div className={`app-shell ${collapsed && !isMobile ? "app-shell-collapsed" : ""}`}>
        <Sidebar
          collapsed={collapsed && !isMobile}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
        />
        <div className="main-shell">
          <Topbar onMenuClick={() => setMobileOpen(true)} />
          <main className="main-content">{children}</main>
        </div>
      </div>
    </WorkspaceEmailsProvider>
  );
}
