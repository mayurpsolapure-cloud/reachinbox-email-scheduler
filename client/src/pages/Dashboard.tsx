import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  CircleAlert,
  Clock3,
  Mail,
  MailCheck,
  Plus,
  Send,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "../components/ui";
import { api, fetchAllCampaignEmails } from "../services/api";
import type { Campaign, CampaignEmail } from "../types";
import { errorMessage, formatDate } from "../utils";

type DashboardData = { campaigns: Campaign[]; emails: CampaignEmail[]; leadCount: number };
const chartStatuses = ["sent", "queued", "pending", "processing", "failed", "cancelled"] as const;

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [campaigns, leadResponse] = await Promise.all([api.getCampaigns(), api.getLeads(1, 1)]);
      setData({ campaigns, emails: await fetchAllCampaignEmails(campaigns), leadCount: leadResponse.pagination.total });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const sentActivity = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now);
      date.setDate(now.getDate() - (6 - index));
      date.setHours(0, 0, 0, 0);
      const next = new Date(date);
      next.setDate(date.getDate() + 1);
      const count = data?.emails.filter((email) => {
        const sentAt = email.sent_at ? new Date(email.sent_at) : null;
        return email.status === "sent" && sentAt && sentAt >= date && sentAt < next;
      }).length ?? 0;
      return { label: date.toLocaleDateString(undefined, { weekday: "short" }), count };
    });
  }, [data]);

  if (loading) return <><PageHeader eyebrow="WORKSPACE" title="Overview" description="A clear view of your email operations." /><LoadingState /></>;
  if (error || !data) return <><PageHeader eyebrow="WORKSPACE" title="Overview" description="A clear view of your email operations." /><ErrorState message={error || "Dashboard data is unavailable."} onRetry={() => void load()} /></>;

  const count = (status: string) => data.emails.filter((email) => email.status === status).length;
  const scheduled = data.emails.filter((email) => ["pending", "queued", "processing"].includes(email.status)).length;
  const statusTotal = data.emails.length;
  const maxActivity = Math.max(1, ...sentActivity.map((item) => item.count));
  const recentCampaigns = data.campaigns.slice(0, 4);
  const recentEmails = [...data.emails].sort((a, b) =>
    new Date(b.sent_at ?? b.created_at).getTime() - new Date(a.sent_at ?? a.created_at).getTime()
  ).slice(0, 5);

  return (
    <div className="page-stack">
      <PageHeader eyebrow="WORKSPACE" title="Overview" description="A clear view of your email operations." action={<Link className="button button-primary button-md" to="/compose"><Plus size={16} /> New campaign</Link>} />
      <section className="metric-grid" aria-label="Email statistics">
        <Metric icon={<Send size={17} />} label="Total campaigns" value={data.campaigns.length} foot="Created in this workspace" />
        <Metric icon={<Users size={17} />} label="Total leads" value={data.leadCount} foot="Unique contacts" />
        <Metric icon={<CalendarClock size={17} />} label="Scheduled emails" value={scheduled} foot="Pending, queued or processing" />
        <Metric icon={<MailCheck size={17} />} label="Emails sent" value={count("sent")} foot="Accepted by Gmail API" positive />
        <Metric icon={<CircleAlert size={17} />} label="Failed emails" value={count("failed")} foot="Requires attention" warning />
        <Metric icon={<Clock3 size={17} />} label="Pending emails" value={count("pending")} foot="Waiting to be queued" />
      </section>

      <section className="dashboard-grid">
        <div className="panel activity-panel">
          <div className="panel-heading"><div><h2>Email sending activity</h2><p>Successfully sent messages · last 7 days</p></div><div className="chart-legend"><span className="legend-dot violet" />Sent</div></div>
          {statusTotal === 0 ? <EmptyState title="No email activity yet" description="Once emails are added to campaigns, sending activity will appear here." /> : (
            <div className="activity-chart" role="img" aria-label="Daily emails sent over the last 7 days">
              {sentActivity.map((day) => <div className="activity-column" key={day.label}><span className="activity-value">{day.count || ""}</span><div className="activity-track"><div className="activity-bar" style={{ height: `${Math.max(day.count ? 10 : 2, (day.count / maxActivity) * 100)}%` }} /></div><span className="activity-label">{day.label}</span></div>)}
            </div>
          )}
        </div>
        <div className="panel performance-panel">
          <div className="panel-heading"><div><h2>Email status</h2><p>Current status across all campaigns</p></div></div>
          {statusTotal === 0 ? <EmptyState title="No emails to report" description="Import leads into a campaign to create scheduled emails." /> : (
            <div className="distribution">
              {chartStatuses.map((status) => {
                const amount = count(status);
                return <div className="distribution-row" key={status}><div className="distribution-label"><StatusBadge status={status} /><span>{amount}</span></div><div className="distribution-track"><div className={`distribution-fill fill-${status}`} style={{ width: `${Math.round((amount / statusTotal) * 100)}%` }} /></div></div>;
              })}
            </div>
          )}
        </div>
      </section>

      <section className="panel campaign-performance-panel">
        <div className="panel-heading"><div><h2>Campaign performance</h2><p>Sent emails compared with each campaign’s total email records</p></div></div>
        {data.campaigns.length === 0 ? <EmptyState title="No campaigns to compare" description="Campaign performance appears after you create campaigns and import leads." /> : (
          <div className="campaign-performance-list">
            {data.campaigns.slice(0, 5).map((campaign) => {
              const campaignEmails = data.emails.filter((email) => email.campaign_id === campaign.id);
              const sent = campaignEmails.filter((email) => email.status === "sent").length;
              const total = campaignEmails.length;
              const progress = total ? (sent / total) * 100 : 0;
              return <div className="campaign-performance-row" key={campaign.id}>
                <div className="campaign-performance-name"><span>{campaign.name}</span><small>{sent} / {total} sent</small></div>
                <div className="campaign-performance-track"><div className="campaign-performance-fill" style={{ width: `${progress}%` }} /></div>
                <span className="campaign-performance-percent">{total ? `${Math.round(progress)}%` : "—"}</span>
              </div>;
            })}
          </div>
        )}
      </section>

      <section className="dashboard-grid lower-grid">
        <div className="panel">
          <div className="panel-heading"><div><h2>Recent campaigns</h2><p>Your latest campaign activity</p></div><Link className="text-link" to="/campaigns">View all <ArrowRight size={14} /></Link></div>
          {recentCampaigns.length === 0 ? <EmptyState title="No campaigns yet" description="Create a campaign to start organizing your email outreach." action={<Link className="text-link" to="/compose">Create campaign <ArrowRight size={14} /></Link>} /> : (
            <div className="compact-list">{recentCampaigns.map((campaign) => <Link to="/campaigns" className="campaign-list-item" key={campaign.id}><div className="campaign-initial">{campaign.name.slice(0, 1).toUpperCase()}</div><div className="list-main"><strong>{campaign.name}</strong><span>{Number(campaign.total_emails) || 0} emails · {formatDate(campaign.created_at, { month: "short", day: "numeric" })}</span></div><StatusBadge status={campaign.status} /></Link>)}</div>
          )}
        </div>
        <div className="panel">
          <div className="panel-heading"><div><h2>Recent email activity</h2><p>Latest email records across campaigns</p></div><Link className="text-link" to="/sent">View sent <ArrowRight size={14} /></Link></div>
          {recentEmails.length === 0 ? <EmptyState title="No email activity yet" description="Email activity will appear here after leads are imported." /> : (
            <div className="compact-list">{recentEmails.map((email) => <div className="email-list-item" key={email.id}><div className={`email-list-icon email-icon-${email.status}`}><Mail size={16} /></div><div className="list-main"><strong>{email.recipient_email}</strong><span>{email.subject}</span></div><div className="email-list-meta"><StatusBadge status={email.status} /><time>{formatDate(email.sent_at ?? email.created_at, { month: "short", day: "numeric" })}</time></div></div>)}</div>
          )}
        </div>
      </section>
      <section className="panel quick-actions-panel">
        <div className="panel-heading"><div><h2>Queue status & quick actions</h2><p>Queue details are available in Bull Board.</p></div><Link className="text-link" to="/queue">Open queue monitor <ArrowRight size={14} /></Link></div>
        <div className="quick-actions">
          <Link className="quick-action" to="/compose"><span className="quick-icon"><Plus size={17} /></span><span><strong>Create a campaign</strong><small>Write and configure an email</small></span><ArrowUpRight size={16} /></Link>
          <Link className="quick-action" to="/leads"><span className="quick-icon"><Users size={17} /></span><span><strong>Import leads</strong><small>Add contacts from a CSV file</small></span><ArrowUpRight size={16} /></Link>
          <Link className="quick-action" to="/scheduled"><span className="quick-icon"><CalendarClock size={17} /></span><span><strong>Review scheduled</strong><small>{scheduled} active scheduled emails</small></span><ArrowDownRight size={16} /></Link>
          <div className="quick-action queue-unavailable"><span className="quick-icon"><CircleAlert size={17} /></span><span><strong>Worker health</strong><small>Not exposed by the current API</small></span><CircleAlert size={16} /></div>
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value, foot, positive, warning }: {
  icon: React.ReactNode; label: string; value: number; foot: string; positive?: boolean; warning?: boolean;
}) {
  return <div className="metric-card"><div className="metric-top"><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span></div><strong className="metric-value">{value.toLocaleString()}</strong><span className={`metric-foot ${positive ? "foot-positive" : warning ? "foot-warning" : ""}`}>{foot}</span></div>;
}
