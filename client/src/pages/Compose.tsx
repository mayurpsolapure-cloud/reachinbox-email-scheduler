import { useMemo, useRef, useState } from "react";
import {
  AlignLeft, ArrowLeft, Bold, CalendarClock, Italic, Link2, List, ListOrdered,
  Paperclip, Quote, Redo2, Send, Strikethrough, Underline, Undo2,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../components/ui";
import { useToast } from "../context/ToastContext";
import { useWorkspaceEmails } from "../hooks/useWorkspaceEmails";
import { api } from "../services/api";
import { errorMessage } from "../utils";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type RecipientStats = { valid: string[]; invalid: number; duplicates: number };

function localDateTime(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseRecipients(text: string): RecipientStats {
  const found = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const valid = found.map((email) => email.toLowerCase()).filter((email) => EMAIL_PATTERN.test(email));
  const unique = [...new Set(valid)];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const invalid = lines.filter((line) => !/^(email|e-mail)(\s*,|$)/i.test(line) && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line)).length;
  return { valid: unique, invalid, duplicates: valid.length - unique.length };
}

const quickTimes = [
  { label: "Tomorrow", hour: 9 },
  { label: "Tomorrow, 10:00 AM", hour: 10 },
  { label: "Tomorrow, 11:00 AM", hour: 11 },
  { label: "Tomorrow, 3:00 PM", hour: 15 },
];

export default function Compose() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientInput, setRecipientInput] = useState("");
  const [recipientFileName, setRecipientFileName] = useState("");
  const [recipientStats, setRecipientStats] = useState<RecipientStats>({ valid: [], invalid: 0, duplicates: 0 });
  const [attachments, setAttachments] = useState<File[]>([]);
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [delay, setDelay] = useState("2");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { notify } = useToast();
  const { reload } = useWorkspaceEmails();
  const addressList = useMemo(() => [...new Set([...recipients, ...recipientStats.valid])], [recipients, recipientStats.valid]);

  function addRecipient() {
    const values = recipientInput.split(/[,\s;]+/).map((item) => item.trim()).filter(Boolean);
    const invalid = values.find((item) => !EMAIL_PATTERN.test(item));
    if (invalid) {
      setError(`"${invalid}" is not a valid email address.`);
      return;
    }
    setRecipients((current) => [...new Set([...current, ...values.map((item) => item.toLowerCase())])]);
    setRecipientInput("");
    setError("");
  }

  async function handleRecipientFile(file?: File) {
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setError("Upload a CSV or text file containing email addresses.");
      return;
    }
    try {
      const parsed = parseRecipients(await file.text());
      setRecipientFileName(file.name);
      setRecipientStats(parsed);
      setError(parsed.valid.length ? "" : "No valid email addresses were found in this file.");
    } catch (reason) {
      setError(`Could not read the recipient file: ${errorMessage(reason)}`);
    }
  }

  function setQuickTime(hour: number) {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(hour, 0, 0, 0);
    setScheduleAt(localDateTime(date));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!subject.trim()) return setError("Enter a subject before scheduling.");
    if (!body.trim()) return setError("Enter the email body before scheduling.");
    if (!addressList.length) return setError("Add at least one recipient or upload a recipient list.");
    if (recipientStats.invalid) return setError(`Resolve ${recipientStats.invalid} invalid row(s) in the uploaded list before scheduling.`);
    if (attachments.length) return setError("The backend does not support email attachments yet. Remove attachments to schedule this message.");
    const minimumDelaySeconds = Number(delay);
    if (!Number.isInteger(minimumDelaySeconds) || minimumDelaySeconds < 0) return setError("Delay must be a non-negative whole number of seconds.");
    if (scheduleAt && new Date(scheduleAt).getTime() <= Date.now()) return setError("Choose a schedule time in the future.");

    setSubmitting(true);
    let stage = "creating the campaign";
    try {
      const campaign = await api.createCampaign({
        name: subject.trim().slice(0, 120) || "Email campaign",
        subject: subject.trim(),
        body,
        ...(scheduleAt ? { scheduledAt: new Date(scheduleAt).toISOString() } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        minimumDelaySeconds,
      });
      stage = "importing recipients";
      const csv = new File([`email\r\n${addressList.join("\r\n")}\r\n`], "recipients.csv", { type: "text/csv" });
      await api.importLeads(csv, campaign.id);
      stage = "scheduling emails";
      const result = await api.scheduleCampaign(campaign.id);
      await reload();
      notify(`${result.queued} email${result.queued === 1 ? "" : "s"} added to the schedule.`);
      navigate("/scheduled");
    } catch (reason) {
      const detail = errorMessage(reason);
      setError(stage === "creating the campaign" ? detail : `Campaign was created, but ${stage} failed: ${detail}`);
      notify(stage === "creating the campaign" ? detail : `Campaign created, but ${stage} failed.`, "error");
    } finally {
      setSubmitting(false);
    }
  }

  function addAttachment(fileList: FileList | null) {
    if (!fileList) return;
    setAttachments((current) => [...current, ...Array.from(fileList)]);
  }

  return (
    <div className="compose-page inbox-compose-page">
      <div className="compose-heading">
        <Link to="/scheduled" className="back-link"><ArrowLeft size={16} /></Link>
        <h2>Compose New Email</h2>
        <div className="compose-heading-actions">
          <button type="button" className="compose-icon-button" aria-label="Attach file" title="Attach file" onClick={() => attachmentInput.current?.click()}><Paperclip size={17} /></button>
          <button type="button" className="compose-icon-button" aria-label="Choose send time" title="Send later" onClick={() => setScheduleOpen((open) => !open)}><CalendarClock size={17} /></button>
          <Button type="submit" form="compose-form" variant="primary" disabled={submitting}><Send size={14} />{submitting ? "Scheduling…" : "Schedule"}</Button>
        </div>
        {scheduleOpen && (
          <div className="schedule-popover" role="dialog" aria-label="Send later">
            <h3>Send Later</h3>
            <label>Choose date and time<input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /></label>
            <div className="quick-time-list">
              {quickTimes.map((time) => <button key={time.label} type="button" onClick={() => setQuickTime(time.hour)}>{time.label}</button>)}
            </div>
            <div className="schedule-popover-actions">
              <button type="button" onClick={() => setScheduleOpen(false)}>Cancel</button>
              <button type="button" onClick={() => setScheduleOpen(false)}>Done</button>
            </div>
          </div>
        )}
      </div>
      <form id="compose-form" className="inbox-compose-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="compose-field-row"><span>From</span><strong>Configured test sender</strong></div>
        <div className="compose-field-row compose-recipient-row">
          <span>To</span>
          <div className="recipient-area">
            <div className="recipient-chips">
              {addressList.map((email) => (
                <span className="recipient-chip" key={email}>{email}
                  {recipients.includes(email) && <button type="button" aria-label={`Remove ${email}`} onClick={() => setRecipients((current) => current.filter((value) => value !== email))}>×</button>}
                  {!recipients.includes(email) && <button type="button" aria-label={`Remove ${email}`} onClick={() => setRecipientStats((current) => ({ ...current, valid: current.valid.filter((value) => value !== email) }))}>×</button>}
                </span>
              ))}
              <input value={recipientInput} onChange={(event) => setRecipientInput(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "," || event.key === ";") {
                  event.preventDefault();
                  addRecipient();
                }
              }} onBlur={() => { if (recipientInput.trim()) addRecipient(); }} placeholder="Add recipients" aria-label="Add recipient email" />
            </div>
            <button type="button" className="upload-list-button" onClick={() => fileInput.current?.click()}>Upload List</button>
            <input ref={fileInput} className="sr-only" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => { void handleRecipientFile(event.target.files?.[0]); event.target.value = ""; }} />
          </div>
        </div>
        {recipientFileName && <div className="recipient-file-summary"><span>{recipientFileName}</span><span>{recipientStats.valid.length} valid</span><span>{recipientStats.invalid} invalid</span><span>{recipientStats.duplicates} duplicates</span><button type="button" onClick={() => { setRecipientFileName(""); setRecipientStats({ valid: [], invalid: 0, duplicates: 0 }); }}>Remove</button></div>}
        <label className="compose-field-row subject-row"><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Enter subject" maxLength={500} /></label>
        <div className="compose-options">
          <label>Delay between emails<input type="number" min="0" step="1" value={delay} onChange={(event) => setDelay(event.target.value)} /><span>seconds</span></label>
          <div className="server-setting"><strong>Hourly limit</strong><span>Managed by backend configuration</span></div>
        </div>
        <div className="plain-text-notice">The current mail API sends plain-text messages. Rich formatting and file attachments are not supported by this backend.</div>
        <div className="editor-toolbar" aria-label="Text formatting (not supported by the plain-text backend)">
          {[Undo2, Redo2, Bold, Italic, Underline, AlignLeft, ListOrdered, List, Quote, Strikethrough, Link2].map((Icon, index) => (
            <button type="button" key={index} disabled title="Formatting is unavailable for plain-text delivery"><Icon size={15} /></button>
          ))}
        </div>
        <textarea className="inbox-email-editor" rows={12} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your email..." aria-label="Email body" />
        {attachments.length > 0 && <div className="attachment-list">{attachments.map((file, index) => <div className="attachment-item" key={`${file.name}-${index}`}><Paperclip size={14} /><span>{file.name} · {(file.size / 1024).toFixed(1)} KB</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, fileIndex) => fileIndex !== index))}>×</button></div>)}</div>}
        <input ref={attachmentInput} className="sr-only" type="file" multiple onChange={(event) => { addAttachment(event.target.files); event.target.value = ""; }} />
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="compose-footer-actions">
          <span>{addressList.length} recipient{addressList.length === 1 ? "" : "s"} · {scheduleAt ? `Scheduled for ${new Date(scheduleAt).toLocaleString()}` : "Send as soon as possible"}</span>
          <Button type="submit" variant="primary" disabled={submitting}><Send size={14} />{submitting ? "Scheduling…" : "Schedule email"}</Button>
        </div>
      </form>
    </div>
  );
}
