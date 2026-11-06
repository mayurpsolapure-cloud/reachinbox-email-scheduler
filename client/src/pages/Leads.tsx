import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Search, Upload, Users } from "lucide-react";
import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, PaginationBar, StatusBadge } from "../components/ui";
import { useToast } from "../context/ToastContext";
import { ApiError, api } from "../services/api";
import type { Campaign, Lead, LeadImportResult, Pagination } from "../types";
import { errorMessage, initials, formatDate } from "../utils";

type Preview = { headers: string[]; rows: string[][] };
const PAGE_SIZE = 20;

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell.trim()); cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index++;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = []; cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

export default function Leads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [campaignId, setCampaignId] = useState("");
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [result, setResult] = useState<LeadImportResult | null>(null);
  const [invalidCount, setInvalidCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { notify } = useToast();

  async function loadLeads(nextPage = page) {
    setLoading(true);
    setError("");
    try {
      const response = await api.getLeads(nextPage, PAGE_SIZE);
      setLeads(response.leads);
      setPagination(response.pagination);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadLeads(page); }, [page]);
  useEffect(() => {
    api.getCampaigns().then(setCampaigns).catch((reason: unknown) => notify(`Could not load campaign options: ${errorMessage(reason)}`, "error"));
  }, [notify]);

  const visibleLeads = useMemo(() => leads.filter((lead) =>
    `${lead.email} ${lead.first_name ?? ""} ${lead.last_name ?? ""} ${lead.company ?? ""}`.toLowerCase().includes(query.toLowerCase())
  ), [leads, query]);

  async function chooseFile(chosen?: File) {
    if (!chosen) return;
    setImportError("");
    setResult(null);
    if (!chosen.name.toLowerCase().endsWith(".csv")) { setImportError("Choose a CSV file."); return; }
    if (chosen.size > 5 * 1024 * 1024) { setImportError("File exceeds the 5 MB upload limit."); return; }
    setFile(chosen);
    setReading(true);
    try {
      const rows = parseCsv(await chosen.text());
      if (rows.length < 2) throw new Error("CSV must include a header and at least one lead row.");
      const headers = rows[0].map((header) => header.trim());
      if (!headers.includes("email")) throw new Error("CSV requires an email column named exactly 'email'.");
      const emailIndex = headers.indexOf("email");
      const invalid = rows.slice(1).filter((row) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row[emailIndex] ?? "")).length;
      setInvalidCount(invalid);
      setPreview({ headers, rows: rows.slice(1, 6) });
    } catch (reason) {
      setFile(null);
      setPreview(null);
      setImportError(errorMessage(reason));
    } finally { setReading(false); }
  }

  function resetImport() {
    setFile(null); setPreview(null); setResult(null); setImportError(""); setInvalidCount(0); setCampaignId("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function importFile() {
    if (!file || importing || invalidCount > 0) return;
    setImporting(true);
    setImportError("");
    try {
      const response = await api.importLeads(file, campaignId);
      setResult(response);
      notify(`${response.imported} lead${response.imported === 1 ? "" : "s"} imported successfully.`);
      await loadLeads(page);
    } catch (reason) {
      setImportError(errorMessage(reason));
      if (reason instanceof ApiError && Array.isArray(reason.details)) setInvalidCount(reason.details.length);
      notify(errorMessage(reason), "error");
    } finally { setImporting(false); }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="AUDIENCE" title="Leads" description="Manage the people your campaigns are reaching." action={<Button variant="primary" onClick={() => { resetImport(); setImportOpen(true); }}><Upload size={16} /> Import CSV</Button>} />
      <div className="lead-stats-row"><div className="lead-total-card"><span className="metric-icon"><Users size={17} /></span><span><strong>{pagination.total.toLocaleString()}</strong><small>Total leads</small></span></div><div className="lead-import-hint"><FileSpreadsheet size={16} /><span>Import CSV with <code>email</code>, <code>first_name</code>, <code>last_name</code>, and <code>company</code> columns.</span></div></div>
      <section className="panel data-panel">
        <div className="table-toolbar"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this page…" aria-label="Search currently loaded leads" /><span className="search-scope">This page</span></div><span className="toolbar-count">{pagination.total.toLocaleString()} contacts</span></div>
        {loading ? <LoadingState label="Loading leads…" /> : error ? <ErrorState message={error} onRetry={() => void loadLeads(page)} /> : visibleLeads.length === 0 ? <EmptyState title={pagination.total ? "No leads match" : "No leads yet"} description={pagination.total ? "No leads on this page match your search." : "Import a CSV file to add your first contacts."} action={!pagination.total ? <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}><Upload size={15} /> Import CSV</Button> : undefined} /> : (
          <div className="table-scroll"><table className="data-table"><thead><tr><th>Lead</th><th>Email</th><th>Company</th><th>Added</th></tr></thead><tbody>
            {visibleLeads.map((lead) => <LeadRow key={lead.id} lead={lead} />)}
          </tbody></table></div>
        )}
        {!loading && !error && pagination.total > PAGE_SIZE && <PaginationBar pagination={pagination} onPageChange={setPage} />}
      </section>
      {importOpen && <Modal title="Import leads" description="Upload a CSV. New contacts will be added to your workspace." onClose={() => setImportOpen(false)} wide>
        {result ? <div className="import-result">
          <div className="import-success-icon"><CheckCircle2 size={22} /></div><h3>Import complete</h3><p>Your CSV was processed successfully.</p>
          <div className="result-grid"><ResultStat label="Imported" value={result.imported} good /><ResultStat label="Duplicates" value={result.duplicates} /><ResultStat label="Invalid rows" value={invalidCount} /><ResultStat label="Emails created" value={result.scheduledEmailsCreated} /></div>
          <div className="modal-actions"><span className="draft-hint"> {campaignId ? "Scheduled email records are pending; queue them from Campaigns." : "No campaign selected — leads were added without email records."}</span><Button variant="primary" onClick={() => { setImportOpen(false); resetImport(); }}>Done</Button></div>
        </div> : <>
          <div className={`upload-dropzone ${dragging ? "drop-active" : ""} ${file ? "drop-has-file" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void chooseFile(event.dataTransfer.files[0]); }}>
            <input ref={inputRef} className="sr-only" type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event.target.files?.[0])} />
            <div className="upload-icon"><FileSpreadsheet size={22} /></div>
            <strong>{file ? file.name : "Drop your CSV file here"}</strong>
            <span>{file ? `${(file.size / 1024).toFixed(1)} KB · maximum 5 MB` : "or select a file from your device"}</span>
            <Button type="button" onClick={() => inputRef.current?.click()}>{file ? "Choose another file" : "Browse files"}</Button>
          </div>
          {reading && <LoadingState label="Reading CSV preview…" />}
          {preview && <div className="csv-preview"><div className="preview-table-heading"><strong>CSV preview</strong><span>First {Math.min(5, preview.rows.length)} rows</span></div><div className="table-scroll"><table className="data-table"><thead><tr>{preview.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{preview!.headers.map((header, index) => <td key={header}>{row[index] || "—"}</td>)}</tr>)}</tbody></table></div>
            <div className="csv-validation">{invalidCount > 0 ? <span className="validation-error"><AlertCircle size={15} /> {invalidCount} row{invalidCount === 1 ? " has" : "s have"} a missing or invalid email. Fix the file before importing.</span> : <span className="validation-good"><CheckCircle2 size={15} /> Email addresses look valid.</span>}</div>
          </div>}
          <label className="field campaign-select-field"><span className="field-label">Add leads to campaign <span className="optional-label">Optional</span></span><select value={campaignId} onChange={(event) => setCampaignId(event.target.value)}><option value="">Import leads only</option>{campaigns.map((campaign) => <option value={campaign.id} key={campaign.id}>{campaign.name} · {campaign.status}</option>)}</select><span className="field-note">Selecting a campaign creates pending scheduled emails for imported leads.</span></label>
          {importError && <div className="inline-error" role="alert"><AlertCircle size={15} />{importError}</div>}
          <div className="modal-actions"><Button type="button" onClick={() => setImportOpen(false)}>Cancel</Button><Button variant="primary" disabled={!file || importing || reading || invalidCount > 0} onClick={() => void importFile()}>{importing ? "Importing…" : <><Upload size={15} /> Import leads</>}</Button></div>
        </>}
      </Modal>}
    </div>
  );
}

function LeadRow({ lead }: { lead: Lead }) {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  return <tr><td><div className="table-primary"><div className="lead-avatar">{initials(lead.first_name, lead.last_name)}</div><div><strong>{name || "—"}</strong><span className="table-subtext">{lead.email}</span></div></div></td><td>{lead.email}</td><td>{lead.company || <span className="muted-cell">—</span>}</td><td>{formatDate(lead.created_at, { month: "short", day: "numeric", year: "numeric" })}</td></tr>;
}

function ResultStat({ label, value, good }: { label: string; value: number; good?: boolean }) {
  return <div className="result-stat"><span>{label}</span><strong className={good ? "result-good" : ""}>{value.toLocaleString()}</strong>{label === "Emails created" && <StatusBadge status="pending" />}</div>;
}
