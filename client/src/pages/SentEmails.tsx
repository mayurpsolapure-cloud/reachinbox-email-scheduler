import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { EmailList } from "../components/EmailList";
import { useWorkspaceEmails } from "../hooks/useWorkspaceEmails";

export default function SentEmails() {
  const { emails, loading, error, reload } = useWorkspaceEmails();
  const rows = emails.filter((email) => ["sent", "failed"].includes(email.status));
  return (
    <div className="inbox-page">
      <div className="folder-heading">
        <div><h2>Sent Emails</h2><p>{loading ? "Loading…" : `${rows.length} messages sent`}</p></div>
        <Link className="compose-link folder-compose" to="/compose"><Plus size={15} /> Compose New Email</Link>
      </div>
      <EmailList emails={rows} folder="sent" loading={loading} error={error} onRefresh={() => void reload()} />
      <p className="backend-note">Sent status reflects acceptance by the configured Ethereal test transport, not delivery to a recipient's real inbox.</p>
    </div>
  );
}
