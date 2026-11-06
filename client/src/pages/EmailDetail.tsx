import { ArrowLeft, Star } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ErrorState, LoadingState, StatusBadge } from "../components/ui";
import { useWorkspaceEmails } from "../hooks/useWorkspaceEmails";
import { formatDate } from "../utils";

export default function EmailDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { emails, loading, error, reload } = useWorkspaceEmails();
  const email = emails.find((item) => item.id === id);

  if (loading) return <LoadingState label="Loading email…" />;
  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!email) {
    return <div className="detail-page"><button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={16} /> Back</button><div className="detail-missing">This email could not be found in the workspace.</div></div>;
  }

  const timestamp = email.status === "sent" ? email.sent_at : email.scheduled_for;
  return (
    <article className="detail-page">
      <div className="detail-toolbar">
        <Link className="back-link" to={email.status === "sent" || email.status === "failed" ? "/sent" : "/scheduled"}><ArrowLeft size={16} /> Back to {email.status === "sent" || email.status === "failed" ? "Sent" : "Scheduled"}</Link>
        <button className="favorite-button" disabled aria-label="Favorites are not supported by the backend" title="Favorites are not supported by the backend"><Star size={16} /></button>
      </div>
      <h2 className="detail-subject">{email.subject}</h2>
      <div className="detail-message-header">
        <div className="detail-sender-avatar">R</div>
        <div className="detail-sender-copy"><strong>ReachInbox Scheduler</strong><span>Configured test sender</span></div>
        <div className="detail-message-meta"><StatusBadge status={email.status} /><time>{formatDate(timestamp)}</time></div>
      </div>
      <p className="detail-recipient"><span>To:</span> {email.recipient_email}</p>
      <div className="detail-message-body">{email.body}</div>
      <p className="backend-note">The current API does not expose sender address or attachment data for this message.</p>
    </article>
  );
}
