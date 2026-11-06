
import { elasticsearchClient } from "../config/elasticsearch.js";
import { pool } from "../config/database.js";

const EMAIL_INDEX = "sent-emails";

export interface EmailSearchDocument {
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

// Create the index or update mappings if it already exists.
let indexSetup: Promise<void> | null = null;

export async function ensureEmailIndex(): Promise<void> {
  if (!indexSetup) {
    indexSetup = (async () => {
      const exists = await elasticsearchClient.indices.exists({
        index: EMAIL_INDEX,
      });

      const properties = {
        emailId: { type: "keyword" as const },
        campaignId: { type: "keyword" as const },
        recipientEmail: {
          type: "text" as const,
          fields: {
            keyword: { type: "keyword" as const },
          },
        },
        subject: { type: "text" as const },
        body: { type: "text" as const },
        senderId: { type: "keyword" as const },
        status: { type: "keyword" as const },
        sentAt: { type: "date" as const },
        company: {
          type: "text" as const,
          fields: {
            keyword: { type: "keyword" as const },
          },
        },
        firstName: { type: "text" as const },
        lastName: { type: "text" as const },
      };

      if (!exists) {
        await elasticsearchClient.indices.create({
          index: EMAIL_INDEX,
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
          },
          mappings: {
            properties,
          },
        });

        console.log("Elasticsearch index created:", EMAIL_INDEX);
      } else {
        await elasticsearchClient.indices.putMapping({
          index: EMAIL_INDEX,
          properties,
        });

        console.log("Elasticsearch mappings verified:", EMAIL_INDEX);
      }
    })().catch((error) => {
      indexSetup = null;
      throw error;
    });
  }

  await indexSetup;
}

// Index one sent email.
// The email ID is used as the document ID to prevent duplicate documents.
export async function indexSentEmail(
  document: EmailSearchDocument
): Promise<void> {
  await ensureEmailIndex();

  await elasticsearchClient.index({
    index: EMAIL_INDEX,
    id: document.emailId,
    document,
    refresh: "wait_for",
  });
}

// Search by recipient, subject, body, company and lead name.
export async function searchSentEmails(
  query: string,
  userId: string
): Promise<EmailSearchDocument[]> {
  await ensureEmailIndex();

  const campaignResult = await pool.query<{ id: string }>(
    "SELECT id FROM campaigns WHERE user_id = $1",
    [userId]
  );
  const campaignIds = campaignResult.rows.map((campaign) => campaign.id);
  if (campaignIds.length === 0) return [];

  const response =
    await elasticsearchClient.search<EmailSearchDocument>({
      index: EMAIL_INDEX,
      size: 25,
      sort: [{ sentAt: "desc" }],
      query: {
        bool: {
          filter: [{ terms: { campaignId: campaignIds } }],
          must: [{
            multi_match: {
              query,
              fields: [
                "recipientEmail",
                "subject",
                "body",
                "company",
                "firstName",
                "lastName",
              ],
              type: "best_fields",
            },
          }],
        },
      },
    });

  const results: EmailSearchDocument[] = [];

  for (const hit of response.hits.hits) {
    if (hit._source) {
      results.push(hit._source);
    }
  }

  return results;
}

// Re-index previously sent emails from PostgreSQL.
export async function backfillSentEmails(): Promise<number> {
  await ensureEmailIndex();

  const result = await pool.query(
    `SELECT
       se.id,
       se.campaign_id,
       se.recipient_email,
       se.subject,
       se.body,
       se.email_account_id,
       se.sent_at,
       l.company,
       l.first_name,
       l.last_name
     FROM scheduled_emails se
     JOIN leads l ON l.id = se.lead_id
     WHERE se.status = 'sent'
       AND se.sent_at IS NOT NULL
     ORDER BY se.sent_at DESC
     LIMIT 1000`
  );

  for (const email of result.rows) {
    await indexSentEmail({
      emailId: email.id,
      campaignId: email.campaign_id,
      recipientEmail: email.recipient_email,
      subject: email.subject,
      body: email.body,
      senderId:
        email.email_account_id ?? "default-ethereal-sender",
      status: "sent",
      sentAt: new Date(email.sent_at).toISOString(),
      company: email.company,
      firstName: email.first_name,
      lastName: email.last_name,
    });
  }

  console.log(
    `Elasticsearch backfill completed: ${result.rowCount ?? 0} emails`
  );

  return result.rowCount ?? 0;
}
