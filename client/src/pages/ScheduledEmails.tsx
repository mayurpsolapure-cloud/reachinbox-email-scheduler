import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { EmailList } from "../components/EmailList";
import { useWorkspaceEmails } from "../hooks/useWorkspaceEmails";

export default function ScheduledEmails() {
  const { campaigns, emails, loading, error, reload } = useWorkspaceEmails();
  const rows = emails.filter((email) => ["pending", "queued", "processing"].includes(email.status));
  return (
    <div className="inbox-page">
      <div className="folder-heading">
        <div><h2>Scheduled Emails</h2><p>{loading ? "Loading…" : `${rows.length} messages in your schedule`}</p></div>
        <Link className="compose-link folder-compose" to="/compose"><Plus size={15} /> Compose New Email</Link>
      </div>
      <EmailList emails={rows} folder="scheduled" loading={loading} error={error} onRefresh={() => void reload()} />
      {campaigns.length === 0 && !loading && <span className="sr-only">No campaigns exist in this workspace.</span>}
    </div>
  );
}
