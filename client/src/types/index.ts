export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "processing"
  | "completed"
  | "paused"
  | "failed";

export type EmailStatus =
  | "pending"
  | "queued"
  | "processing"
  | "sent"
  | "failed"
  | "cancelled";

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  body: string;
  status: CampaignStatus | string;
  scheduled_at: string | null;
  timezone: string;
  minimum_delay_seconds: number;
  created_at: string;
  updated_at: string;
  total_emails: number | string;
}

export interface CampaignEmail {
  id: string;
  campaign_id: string;
  lead_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  status: EmailStatus | string;
  scheduled_for: string;
  sent_at: string | null;
  attempt_count: number;
  last_error: string | null;
  email_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  created_at: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface LeadImportResult {
  message: string;
  totalRows: number;
  imported: number;
  duplicates: number;
  scheduledEmailsCreated: number;
}

export interface EmailSearchResult {
  emailId: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  senderId: string;
  status: string;
  sentAt: string;
  company?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}
