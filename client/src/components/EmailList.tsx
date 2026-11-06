import { useMemo, useState } from "react";
import { Filter, RefreshCw, Search, Star } from "lucide-react";
import { Link } from "react-router-dom";
import type { CampaignEmail } from "../types";
import { formatDate } from "../utils";
import { ErrorState, EmptyState, LoadingState, StatusBadge } from "./ui";

type EmailListProps = {
  emails: CampaignEmail[];
  folder: "scheduled" | "sent";
  loading: boolean;
  error: string;
  onRefresh: () => void;
};

export function EmailList({ emails, folder, loading, error, onRefresh }: EmailListProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const visibleEmails = useMemo(() => emails
    .filter((email) => (status === "all" || email.status === status))
    .filter((email) => `${email.recipient_email} ${email.subject} ${email.body}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => folder === "scheduled"
      ? new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime()
      : new Date(b.sent_at ?? b.updated_at).getTime() - new Date(a.sent_at ?? a.updated_at).getTime()),
  [emails, folder, query, status]);

  return (
    <section className="inbox-content" aria-label={`${folder} email list`}>
      <div className="inbox-toolbar">
        <label className="inbox-search">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search emails..." aria-label={`Search ${folder} emails by recipient, subject or content`} />
        </label>
        <label className="inbox-filter" title="Filter by status">
          <Filter size={15} aria-hidden="true" />
          <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            {(folder === "scheduled" ? ["pending", "queued", "processing"] : ["sent", "failed"]).map((item) => (
              <option value={item} key={item}>{item[0].toUpperCase() + item.slice(1)}</option>
            ))}
          </select>
        </label>
        <button className="refresh-button" onClick={onRefresh} aria-label="Refresh emails" title="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>
      {!loading && !error && (
        <div className="list-count" aria-live="polite">
          {visibleEmails.length} {folder === "scheduled" ? "scheduled" : "sent"} {visibleEmails.length === 1 ? "email" : "emails"}
        </div>
      )}
      {loading ? <LoadingState label="Loading emails…" /> : error ? <ErrorState message={error} onRetry={onRefresh} /> : visibleEmails.length === 0 ? (
        <EmptyState
          title={emails.length ? "No emails match your search" : `No ${folder} emails`}
          description={emails.length ? "Try changing the search or status filter." : folder === "scheduled" ? "Create a new email and schedule it to see it here." : "Successfully sent or failed emails will appear here."}
        />
      ) : (
        <div className="email-rows">
          {visibleEmails.map((email) => (
            <article className="email-row" key={email.id}>
              <Link className="email-row-link" to={`/email/${encodeURIComponent(email.id)}`} aria-label={`Open ${email.subject}, to ${email.recipient_email}`}>
                <div className="email-row-top">
                  <span className="email-recipient">To: <strong>{email.recipient_email}</strong></span>
                  {folder === "scheduled" && email.status !== "failed" ? (
                    <span className="scheduled-time">{formatDate(email.scheduled_for, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  ) : <StatusBadge status={email.status} />}
                </div>
                <strong className="email-subject">{email.subject}</strong>
                <span className="email-preview">{email.body.replace(/\s+/g, " ").trim() || "No message preview available."}</span>
              </Link>
              <button className="favorite-button" disabled aria-label="Favorites are not supported by the backend" title="Favorites are not supported by the backend">
                <Star size={16} />
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
