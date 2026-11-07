import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import {
  GmailAuthorizationError,
  loadGmailAuthorization,
  requireGmailReauthorization,
} from "./gmail-auth.service.js";

export type GmailApiResponse = {
  id: string;
  threadId?: string | null;
  labelIds?: string[] | null;
  recovered?: boolean;
};

export type GmailClient = {
  getAuthenticatedIdentity(): Promise<{ email: string; googleSub: string }>;
  sendMessage(raw: string): Promise<GmailApiResponse>;
};

export type GmailApiBindings = {
  refreshAccessToken: () => Promise<unknown>;
  getUserInfo: () => Promise<{ data: { id?: string | null; email?: string | null } }>;
  sendMessage: (request: {
    userId: "me";
    requestBody: { raw: string };
  }) => Promise<{
    data: {
      id?: string | null;
      threadId?: string | null;
      labelIds?: string[] | null;
    };
  }>;
};

export type GmailServiceDependencies = {
  loadAuthorization: typeof loadGmailAuthorization;
  markReauthorizationRequired: typeof requireGmailReauthorization;
  createClient: (refreshToken: string) => Promise<GmailClient>;
};

export class GmailSendOutcomeUnknownError extends Error {
  constructor() {
    super("Gmail send outcome is unknown; verify the message before scheduling another send");
    this.name = "GmailSendOutcomeUnknownError";
  }
}

export async function refreshGmailAccessToken(
  refresh: () => Promise<unknown>
): Promise<void> {
  await refresh();
}

function encodeMimeBody(body: string): string {
  return Buffer.from(body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trim();
}

function headerValue(value: string, label: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid ${label} header`);
  return value;
}

function encodedSubject(subject: string): string {
  const safeSubject = headerValue(subject, "subject");
  return `=?UTF-8?B?${Buffer.from(safeSubject, "utf8").toString("base64")}?=`;
}

function makeMessageId(emailId: string): string {
  return `<reachinbox-${emailId}@reachinbox.invalid>`;
}

export function createMimeMessage(input: {
  emailId: string;
  from: string;
  recipient: string;
  subject: string;
  body: string;
}): string {
  const boundary = `reachinbox-${input.emailId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const html = input.body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br>");
  const message = [
    `From: ${headerValue(input.from, "sender")}`,
    `To: ${headerValue(input.recipient, "recipient")}`,
    `Subject: ${encodedSubject(input.subject)}`,
    `Message-ID: ${makeMessageId(input.emailId)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeMimeBody(input.body),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeMimeBody(`<div>${html}</div>`),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

export function createGmailApiAdapter(bindings: GmailApiBindings): GmailClient {
  return {
    async getAuthenticatedIdentity() {
      await refreshGmailAccessToken(bindings.refreshAccessToken);
      const { data } = await bindings.getUserInfo();
      if (!data.email || !data.id) {
        throw new Error("Google did not return the Gmail authorization identity");
      }
      return { email: data.email.toLowerCase(), googleSub: data.id };
    },
    async sendMessage(raw) {
      const { data } = await bindings.sendMessage({
        userId: "me",
        requestBody: { raw },
      });
      if (!data.id) throw new Error("Gmail did not confirm the sent message ID");
      return {
        id: data.id,
        ...(data.threadId ? { threadId: data.threadId } : {}),
        ...(data.labelIds ? { labelIds: data.labelIds } : {}),
      };
    },
  };
}

function defaultClient(refreshToken: string): Promise<GmailClient> {
  const oauth2 = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });

  return Promise.resolve(createGmailApiAdapter({
    refreshAccessToken: () => oauth2.getAccessToken(),
    getUserInfo: () => oauth2Api.userinfo.get(),
    sendMessage: (request) => gmail.users.messages.send(request),
  }));
}

const defaultDependencies: GmailServiceDependencies = {
  loadAuthorization: loadGmailAuthorization,
  markReauthorizationRequired: requireGmailReauthorization,
  createClient: defaultClient,
};

function isAuthorizationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as {
    code?: string;
    response?: { status?: number; data?: { error?: string } };
  };
  return value.code === "invalid_grant" ||
    value.response?.status === 401 ||
    (value.response?.status === 403 &&
      JSON.stringify(value.response.data ?? {}).toLowerCase().includes("insufficient"));
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { response?: { status?: number } }).response?.status;
}

export function createGmailEmailService(
  dependencies: GmailServiceDependencies = defaultDependencies
) {
  return async function sendGmailEmail(input: {
    userId: string;
    emailId: string;
    recipient: string;
    subject: string;
    body: string;
    senderAddress: string;
    sendAttempted: boolean;
    existingMessageId: string | null;
    markSendAttempted: () => Promise<boolean>;
    clearSendAttempt: () => Promise<void>;
  }): Promise<GmailApiResponse> {
    if (input.existingMessageId) return { id: input.existingMessageId, recovered: true };

    const authorization = await dependencies.loadAuthorization(input.userId);
    if (authorization.email.toLowerCase() !== input.senderAddress.toLowerCase()) {
      throw new Error("Scheduled sender does not match the authorized Gmail account");
    }

    let client: GmailClient;
    try {
      client = await dependencies.createClient(authorization.refreshToken);
      const identity = await client.getAuthenticatedIdentity();
      if (
        identity.email.toLowerCase() !== authorization.email.toLowerCase() ||
        identity.googleSub !== authorization.googleSub
      ) {
        await dependencies.markReauthorizationRequired(input.userId);
        throw new Error("Authenticated Gmail identity does not match the connected account");
      }
    } catch (error) {
      if (isAuthorizationFailure(error)) {
        await dependencies.markReauthorizationRequired(input.userId);
      }
      throw error;
    }

    if (input.sendAttempted) {
      throw new GmailSendOutcomeUnknownError();
    }

    const claimed = await input.markSendAttempted();
    if (!claimed) throw new GmailSendOutcomeUnknownError();
    try {
      return await client.sendMessage(
        createMimeMessage({
          emailId: input.emailId,
          from: input.senderAddress,
          recipient: input.recipient,
          subject: input.subject,
          body: input.body,
        })
      );
    } catch (error) {
      const status = responseStatus(error);
      if (isAuthorizationFailure(error)) {
        await dependencies.markReauthorizationRequired(input.userId);
        throw new GmailAuthorizationError(
          "Gmail authorization expired or was revoked. Reconnect Gmail in Settings.",
          "revoked_or_expired"
        );
      }
      if (status === 429 || (status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403)) {
        await input.clearSendAttempt();
        throw error;
      }
      throw new GmailSendOutcomeUnknownError();
    }
  };
}

export const sendGmailEmail = createGmailEmailService();
