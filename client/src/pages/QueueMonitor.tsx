import { useEffect, useState } from "react";
import { Activity, ArrowUpRight, CheckCircle2, ExternalLink, Info, Server, ShieldAlert } from "lucide-react";
import { ErrorState, LoadingState, PageHeader } from "../components/ui";

type DbHealth = { status: string; database: string; time: string };

export default function QueueMonitor() {
  const [health, setHealth] = useState<DbHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadHealth() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/health/db");
      const payload = await response.json() as DbHealth & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Health request failed (${response.status}).`);
      setHealth(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load backend health.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void loadHealth(); }, []);

  return <div className="page-stack">
    <PageHeader eyebrow="OPERATIONS" title="Queue monitor" description="Inspect the BullMQ queue and verify the backend connection." />
    <section className="queue-hero panel">
      <div className="queue-hero-top"><div className="queue-illustration"><Activity size={26} /></div><div className="queue-hero-copy"><span className="eyebrow">BULLMQ · EMAIL-SENDING</span><h2>Queue operations</h2><p>Detailed queue inspection is handled by the Bull Board dashboard.</p></div></div>
      <a className="button button-primary button-md queue-open-button" href="http://localhost:5000/admin/queues" target="_blank" rel="noopener noreferrer">Open Bull Board <ExternalLink size={15} /></a>
    </section>
    <div className="queue-grid">
      <section className="panel queue-health-panel">
        <div className="panel-heading"><div><h2>Backend health</h2><p>Database connection health exposed by the API</p></div><Server size={18} className="panel-heading-icon" /></div>
        {loading ? <LoadingState label="Checking backend health…" /> : error ? <ErrorState message={error} onRetry={() => void loadHealth()} /> : health ? <div className="health-status"><span className="health-check"><CheckCircle2 size={18} /></span><div><strong>{health.database || health.status}</strong><span>Connected · last checked {new Date(health.time).toLocaleTimeString()}</span></div><span className="health-online">Online</span></div> : null}
      </section>
      <section className="panel queue-health-panel">
        <div className="panel-heading"><div><h2>Worker information</h2><p>Worker runtime status is not exposed as an API endpoint.</p></div><ShieldAlert size={18} className="panel-heading-icon" /></div>
        <div className="unavailable-block"><span><Info size={17} /></span><div><strong>Not available in this workspace</strong><p>The frontend does not infer a live worker state. Use Bull Board to inspect queue jobs; use your server logs to verify worker health.</p></div></div>
      </section>
    </div>
    <div className="queue-note"><Info size={15} /><span>Bull Board is served by your backend at <code>http://localhost:5000/admin/queues</code>. If it is protected by HTTP basic auth, enter the credentials configured on the backend.</span><a href="http://localhost:5000/admin/queues" target="_blank" rel="noopener noreferrer" aria-label="Open Bull Board in a new tab"><ArrowUpRight size={15} /></a></div>
  </div>;
}
