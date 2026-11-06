import { useState } from "react";
import { MailSearch, Search, SearchX } from "lucide-react";
import { Button, EmptyState, LoadingState, PageHeader, StatusBadge } from "../components/ui";
import { api } from "../services/api";
import type { EmailSearchResult } from "../types";
import { errorMessage, formatDate } from "../utils";

export default function SearchEmails() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<EmailSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (!value) { setError("Enter a recipient, subject, company, or phrase to search."); return; }
    if (value.length > 200) { setError("Search must be 200 characters or fewer."); return; }
    setLoading(true);
    setError("");
    setSubmittedQuery(value);
    try { setResults(await api.searchEmails(value)); }
    catch (reason) { setResults([]); setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }

  return <div className="page-stack search-page">
    <PageHeader eyebrow="EMAILS / SEARCH" title="Search emails" description="Find sent messages by recipient, subject, company, or email content." />
    <section className="search-hero panel">
      <div className="search-hero-icon"><MailSearch size={22} /></div>
      <h2>Search your sent email archive</h2>
      <p>Search runs against indexed sent emails and matching lead information.</p>
      <form className="email-search-form" onSubmit={(event) => void search(event)}>
        <Search size={18} /><input value={query} onChange={(event) => { setQuery(event.target.value); setError(""); }} placeholder="Try a recipient, company, subject, or phrase…" aria-label="Search sent emails" maxLength={200} />
        <span className="search-max">{query.length}/200</span><Button variant="primary" type="submit" disabled={loading}><Search size={15} /> Search</Button>
      </form>
      {error && <div className="search-error" role="alert">{error}</div>}
      <div className="search-examples"><span>Searches across</span><span>Recipients</span><span>Subjects</span><span>Companies</span><span>Message content</span></div>
    </section>
    {loading && <LoadingState label="Searching indexed emails…" />}
    {!loading && submittedQuery && !error && <>
      <div className="results-heading"><div><h2>Results</h2><p>{results.length} matching email{results.length === 1 ? "" : "s"} for <strong>“{submittedQuery}”</strong></p></div><span className="result-cap">Up to 25 results</span></div>
      {results.length === 0 ? <EmptyState icon={<SearchX size={20} />} title="No results found" description="Try a different search term. Only sent emails indexed by the backend can appear here." /> : (
        <div className="search-results">{results.map((result) => <SearchResult key={result.emailId} result={result} query={submittedQuery} />)}</div>
      )}
    </>}
    {!submittedQuery && !loading && <div className="search-empty-hint"><Search size={16} /><span>Your results will appear here. Search is powered by the backend’s sent-email index.</span></div>}
  </div>;
}

function SearchResult({ result, query }: { result: EmailSearchResult; query: string }) {
  const highlight = (text: string) => {
    if (!query) return text;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`, "ig"));
    return parts.map((part, index) => part.toLowerCase() === query.toLowerCase()
      ? <mark key={`${part}-${index}`}>{part}</mark>
      : part);
  };
  const recipientName = [result.firstName, result.lastName].filter(Boolean).join(" ");
  return <article className="search-result-card">
    <div className="search-result-top"><div className="search-result-avatar">{recipientName.slice(0, 1).toUpperCase() || result.recipientEmail.slice(0, 1).toUpperCase()}</div><div className="search-result-recipient"><strong>{highlight(result.recipientEmail)}</strong><span>{recipientName || "Recipient"}{result.company ? ` · ${result.company}` : ""}</span></div><StatusBadge status={result.status} /><time>{formatDate(result.sentAt)}</time></div>
    <h3>{highlight(result.subject)}</h3>
    <p className="search-result-body">{highlight(result.body.slice(0, 280))}{result.body.length > 280 ? "…" : ""}</p>
    <div className="search-result-footer"><span>Campaign ID · {result.campaignId.slice(0, 8)}</span><span>Indexed sent email</span></div>
  </article>;
}
