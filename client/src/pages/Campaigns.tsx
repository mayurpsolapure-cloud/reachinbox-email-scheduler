import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarClock, ChevronRight, Plus, Search, Send, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, StatusBadge } from "../components/ui";
import { useToast } from "../context/ToastContext";
import { api } from "../services/api";
import type { Campaign, CampaignEmail } from "../types";
import { errorMessage, formatDate } from "../utils";

const filters = ["all", "draft", "scheduled", "processing", "completed", "paused", "failed"];

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [detailEmails, setDetailEmails] = useState<CampaignEmail[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const { notify } = useToast();

  async function load() {
    setLoading(true);
    setError("");
    try { setCampaigns(await api.getCampaigns()); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => campaigns.filter((campaign) =>
    (status === "all" || campaign.status === status) &&
    `${campaign.name} ${campaign.subject}`.toLowerCase().includes(query.toLowerCase())
  ), [campaigns, query, status]);

  async function openDetails(campaign: Campaign) {
    setSelected(campaign);
    setDetailLoading(true);
    setDetailError("");
    try {
      const [latestCampaign, emails] = await Promise.all([api.getCampaign(campaign.id), api.getCampaignEmails(campaign.id)]);
      setSelected(latestCampaign);
      setDetailEmails(emails);
    } catch (reason) {
      setDetailError(errorMessage(reason));
    } finally { setDetailLoading(false); }
  }

  async function scheduleSelected() {
    if (!selected || scheduling) return;
    if (!window.confirm(`Queue all pending emails in “${selected.name}”? This action cannot be undone.`)) return;
    setScheduling(true);
    try {
      const result = await api.scheduleCampaign(selected.id);
      notify(`Campaign queued: ${result.queued} email${result.queued === 1 ? "" : "s"}.`);
      await openDetails(selected);
      await load();
    } catch (reason) {
      notify(errorMessage(reason), "error");
    } finally { setScheduling(false); }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="CAMPAIGNS" title="Campaigns" description="Create, organize, and schedule your email campaigns." action={<Link className="button button-primary button-md" to="/compose"><Plus size={16} /> New campaign</Link>} />
      <section className="panel data-panel">
        <div className="table-toolbar">
          <div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search campaigns…" aria-label="Search campaigns" /></div>
          <div className="filter-tabs" role="group" aria-label="Filter by campaign status">
            {filters.map((filter) => <button key={filter} className={status === filter ? "filter-tab active" : "filter-tab"} onClick={() => setStatus(filter)}>{filter === "all" ? "All campaigns" : filter}</button>)}
          </div>
        </div>
        {loading ? <LoadingState label="Loading campaigns…" /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : visible.length === 0 ? <EmptyState title={campaigns.length ? "No campaigns match" : "No campaigns yet"} description={campaigns.length ? "Try a different search or status filter." : "Create your first campaign to get started."} action={!campaigns.length ? <Link className="button button-primary button-sm" to="/compose"><Plus size={15} /> Create campaign</Link> : undefined} /> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Campaign</th><th>Subject</th><th>Status</th><th>Email count</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{visible.map((campaign) => <tr key={campaign.id}>
              <td><div className="table-primary"><div className="campaign-initial">{campaign.name.slice(0, 1).toUpperCase()}</div><div><strong>{campaign.name}</strong><span className="table-subtext">{campaign.id.slice(0, 8)}</span></div></div></td>
              <td className="subject-cell">{campaign.subject}</td><td><StatusBadge status={campaign.status} /></td>
              <td><span className="count-cell">{Number(campaign.total_emails) || 0}</span></td><td>{formatDate(campaign.created_at, { month: "short", day: "numeric", year: "numeric" })}</td>
              <td><Button size="sm" onClick={() => void openDetails(campaign)}>View <ChevronRight size={14} /></Button></td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>
      {selected && <Modal title={selected.name} description="Campaign details and associated emails" onClose={() => setSelected(null)} wide>
        {detailLoading ? <LoadingState label="Loading campaign details…" /> : detailError ? <ErrorState message={detailError} onRetry={() => void openDetails(selected)} /> : (
          <>
            <div className="detail-summary">
              <div><span>Subject</span><strong>{selected.subject}</strong></div>
              <div><span>Status</span><StatusBadge status={selected.status} /></div>
              <div><span>Created</span><strong>{formatDate(selected.created_at)}</strong></div>
              <div><span>Scheduled for</span><strong>{formatDate(selected.scheduled_at)}</strong></div>
              <div><span>Minimum delay</span><strong>{selected.minimum_delay_seconds}s</strong></div>
              <div><span>Emails</span><strong>{detailEmails.length}</strong></div>
            </div>
            <div className="detail-body-preview">{selected.body}</div>
            <div className="detail-email-header"><h3>Campaign emails</h3><span>{detailEmails.length} total</span></div>
            {detailEmails.length ? <div className="table-scroll detail-table-scroll"><table className="data-table"><thead><tr><th>Recipient</th><th>Status</th><th>Scheduled time</th><th>Attempts</th></tr></thead><tbody>{detailEmails.slice(0, 8).map((email) => <tr key={email.id}><td>{email.recipient_email}</td><td><StatusBadge status={email.status} /></td><td>{formatDate(email.scheduled_for)}</td><td>{email.attempt_count}</td></tr>)}</tbody></table></div> : <EmptyState title="No emails in this campaign" description="Import leads and select this campaign to create scheduled email records." action={<Link to="/leads" onClick={() => setSelected(null)} className="text-link">Go to leads <ArrowRight size={14} /></Link>} />}
            {detailEmails.some((email) => email.status === "pending") && <div className="modal-actions"><span className="draft-hint"><Users size={15} /> {detailEmails.filter((email) => email.status === "pending").length} pending emails are ready to queue.</span><Button variant="primary" onClick={() => void scheduleSelected()} disabled={scheduling}><Send size={15} />{scheduling ? "Queueing…" : "Schedule campaign"}</Button></div>}
            {!detailEmails.length && <p className="schedule-note"><CalendarClock size={14} /> Campaign scheduling becomes available after leads are imported.</p>}
          </>
        )}
      </Modal>}
    </div>
  );
}
