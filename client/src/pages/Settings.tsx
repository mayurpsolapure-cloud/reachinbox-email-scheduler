import { useEffect, useState } from "react";
import { CheckCircle2, Mail, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Button, ErrorState, LoadingState, PageHeader } from "../components/ui";
import { AUTH_API_ORIGIN, api } from "../services/api";
import type { GmailIntegrationStatus } from "../services/api";

function callbackMessage(code: string | null): string {
  if (code === "permission_denied") return "Gmail sending permission was not granted.";
  if (code === "account_mismatch") return "Authorize the same Google account you use to sign in to ReachInbox.";
  if (code === "missing_refresh_token") return "Google did not provide offline access. Reconnect Gmail and approve the requested permissions.";
  if (code === "cancelled") return "Gmail authorization was cancelled.";
  if (code === "invalid_state") return "The authorization session expired or could not be verified. Please try again.";
  if (code === "configuration") return "Gmail authorization is not configured correctly. Contact your administrator.";
  if (code) return "Gmail could not be connected. Check your Google OAuth configuration and try again.";
  return "";
}

export default function Settings() {
  const [status, setStatus] = useState<GmailIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchParams] = useSearchParams();
  const callbackError = callbackMessage(searchParams.get("gmailError"));
  const connectedMessage = searchParams.get("gmail") === "connected";

  async function loadStatus() {
    setLoading(true);
    setLoadError("");
    try {
      setStatus(await api.getGmailIntegrationStatus());
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Could not load Gmail status.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  function authorizeGmail() {
    window.location.assign(
      new URL("/api/integrations/gmail/connect", AUTH_API_ORIGIN).toString()
    );
  }

  return (
    <div className="inbox-page">
      <PageHeader
        eyebrow="ACCOUNT"
        title="Settings"
        description="Manage the Google account used to send scheduled emails."
      />
      <section className="state-card" aria-labelledby="gmail-integration-heading">
        <span className="state-icon"><Mail size={19} /></span>
        <div>
          <h2 id="gmail-integration-heading">Gmail sending</h2>
          {loading ? <LoadingState label="Checking Gmail authorization…" /> : loadError ? (
            <ErrorState message={loadError} onRetry={() => void loadStatus()} />
          ) : status?.connected ? (
            <>
              <p><CheckCircle2 size={15} /> Connected as <strong>{status.email}</strong></p>
              <p>Scheduled messages are sent using this Google account. Gmail API acceptance does not guarantee final inbox delivery.</p>
              <Button variant="secondary" onClick={authorizeGmail}>
                <RefreshCw size={14} /> Reconnect Gmail
              </Button>
            </>
          ) : (
            <>
              <p>
                {status?.reason === "revoked_or_expired"
                  ? "Gmail authorization expired or was revoked. Reconnect to resume sending."
                  : "Authorize Gmail sending before scheduling a campaign."}
              </p>
              <p>
                ReachInbox needs permission to send from your signed-in Google account. Passwords and App Passwords are never requested.
              </p>
              <Button variant="primary" onClick={authorizeGmail}>
                <Mail size={14} /> Authorize Gmail
              </Button>
            </>
          )}
          {callbackError && <p className="inline-error" role="alert">{callbackError}</p>}
          {connectedMessage && !callbackError && <p role="status">Gmail authorization connected.</p>}
        </div>
      </section>
    </div>
  );
}
