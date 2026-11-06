import { Check, LogOut, Menu, MessageSquare, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { api, AUTH_API_ORIGIN } from "../services/api";
import type { SlackIntegrationStatus } from "../services/api";

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout, user } = useAuth();
  const { notify } = useToast();
  const [slackStatus, setSlackStatus] = useState<SlackIntegrationStatus | null>(null);
  const [slackLoading, setSlackLoading] = useState(true);
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackError, setSlackError] = useState("");

  const refreshSlackStatus = useCallback(async () => {
    setSlackLoading(true);
    try {
      setSlackStatus(await api.getSlackIntegrationStatus());
      setSlackError("");
    } catch {
      setSlackError("Could not load Slack connection status.");
      notify("Could not load Slack connection status.", "error");
    } finally {
      setSlackLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void refreshSlackStatus();
  }, [refreshSlackStatus]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("slack") === "connected") {
      notify("Slack connected successfully.", "success");
      void refreshSlackStatus();
      params.delete("slack");
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    } else if (params.has("slackError")) {
      const error = params.get("slackError");
      notify(
        error === "invalid_state"
          ? "Slack connection could not be verified. Please reconnect."
          : error === "cancelled"
            ? "Slack connection was cancelled."
            : "Could not connect Slack. Please try again.",
        "error"
      );
      params.delete("slackError");
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
  }, [location.pathname, location.search, navigate, notify, refreshSlackStatus]);

  async function handleLogout() {
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch {
      notify("Could not log out. Please try again.", "error");
    }
  }

  function connectSlack() {
    setSlackBusy(true);
    window.location.assign(new URL("/api/integrations/slack/connect", AUTH_API_ORIGIN).toString());
  }

  async function disconnectSlack() {
    setSlackBusy(true);
    try {
      await api.disconnectSlack();
      setSlackStatus({ connected: false });
      notify("Slack disconnected.", "success");
    } catch {
      notify("Could not disconnect Slack. Please try again.", "error");
    } finally {
      setSlackBusy(false);
    }
  }

  return (
    <header className="topbar inbox-topbar">
      <div className="topbar-title">
        <button className="mobile-menu icon-button" aria-label="Open navigation" onClick={onMenuClick}>
          <Menu size={18} />
        </button>
      </div>
      <div className="slack-controls">
        {slackStatus?.connected ? (
          <>
            <span className="slack-connected" title={`Connected to ${slackStatus.teamName ?? "Slack"} / #${slackStatus.channelName}`}>
              <Check size={13} />
              <span>{slackStatus.teamName ?? "Slack"} · #{slackStatus.channelName}</span>
            </span>
            <button type="button" className="slack-action" onClick={connectSlack} disabled={slackBusy}>
              <RefreshCw size={13} /> Reconnect
            </button>
            <button type="button" className="slack-action slack-disconnect" onClick={() => void disconnectSlack()} disabled={slackBusy}>
              <Unplug size={13} /> Disconnect
            </button>
          </>
        ) : (
          <button type="button" className="slack-connect" onClick={connectSlack} disabled={slackBusy || slackLoading}>
            <MessageSquare size={14} /> {slackLoading ? "Checking Slack…" : "Connect Slack"}
          </button>
        )}
        {slackError && <span className="slack-inline-error" role="status">{slackError}</span>}
      </div>
      <div className="topbar-profile">
        {user?.avatarUrl ? <img className="topbar-avatar" src={user.avatarUrl} alt="" /> : <span className="topbar-avatar-fallback">{user?.name.slice(0, 1).toUpperCase()}</span>}
        <span className="topbar-user-copy"><strong>{user?.name}</strong><small>{user?.email}</small></span>
      </div>
      <button className="logout-button" onClick={() => void handleLogout()}>
        <LogOut size={14} /> Logout
      </button>
    </header>
  );
}
