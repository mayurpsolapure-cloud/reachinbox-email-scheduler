import type {
  Campaign,
  CampaignEmail,
  EmailSearchResult,
  Lead,
  LeadImportResult,
  Pagination,
} from "../types";

const API_BASE_URL = "/api";
export const AUTH_API_ORIGIN =
  import.meta.env.VITE_AUTH_API_ORIGIN ||
  (import.meta.env.DEV ? "http://localhost:5000" : window.location.origin);

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export type SlackIntegrationStatus =
  | { connected: false }
  | {
      connected: true;
      teamName: string | null;
      channelName: string;
      connectedAt: string;
    };

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
    });
  } catch {
    throw new ApiError(
      "Unable to reach the API. Check that the backend is running at http://localhost:5000.",
      0
    );
  }

  const text = await response.text();
  let payload: unknown;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const body =
      typeof payload === "object" && payload !== null
        ? (payload as { error?: unknown; message?: unknown; details?: unknown; invalidRows?: unknown })
        : undefined;
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : response.status === 404
            ? "The requested resource was not found."
            : `The request failed (${response.status}).`;
    throw new ApiError(
      message,
      response.status,
      body?.details ?? body?.invalidRows
    );
  }

  if (response.status === 204) return undefined as T;
  if (payload === undefined || payload === null) {
    throw new ApiError("The API returned an empty response.", response.status);
  }
  return payload as T;
}

export const api = {
  async getCurrentUser(): Promise<AuthenticatedUser> {
    const result = await request<{ user: AuthenticatedUser }>("/auth/me");
    return result.user;
  },

  async logout(): Promise<void> {
    await request<void>("/auth/logout", { method: "POST" });
  },

  async getSlackIntegrationStatus(): Promise<SlackIntegrationStatus> {
    return request<SlackIntegrationStatus>("/integrations/slack/status");
  },

  async disconnectSlack(): Promise<void> {
    await request<void>("/integrations/slack/disconnect", { method: "DELETE" });
  },

  async getCampaigns(): Promise<Campaign[]> {
    const result = await request<{ campaigns: Campaign[] }>("/campaigns");
    return result.campaigns;
  },

  async getCampaign(id: string): Promise<Campaign> {
    const result = await request<{ campaign: Campaign }>(
      `/campaigns/${encodeURIComponent(id)}`
    );
    return result.campaign;
  },

  async getCampaignEmails(id: string): Promise<CampaignEmail[]> {
    const result = await request<{ emails: CampaignEmail[] }>(
      `/campaigns/${encodeURIComponent(id)}/emails`
    );
    return result.emails;
  },

  async createCampaign(data: {
    name: string;
    subject: string;
    body: string;
    scheduledAt?: string;
    timezone: string;
    minimumDelaySeconds: number;
  }): Promise<Campaign> {
    const result = await request<{ message: string; campaign: Campaign }>(
      "/campaigns",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }
    );
    return result.campaign;
  },

  async scheduleCampaign(id: string): Promise<{
    message: string;
    totalPending: number;
    queued: number;
  }> {
    return request(`/campaigns/${encodeURIComponent(id)}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  },

  async getLeads(page: number, limit: number): Promise<{
    leads: Lead[];
    pagination: Pagination;
  }> {
    return request(
      `/leads?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`
    );
  },

  async importLeads(file: File, campaignId: string): Promise<LeadImportResult> {
    const formData = new FormData();
    formData.append("file", file);
    if (campaignId) formData.append("campaignId", campaignId);
    return request("/leads/import", { method: "POST", body: formData });
  },

  async searchEmails(query: string): Promise<EmailSearchResult[]> {
    const result = await request<{ emails: EmailSearchResult[] }>(
      `/search/emails?q=${encodeURIComponent(query)}`
    );
    return result.emails;
  },
};

export async function fetchAllCampaignEmails(
  campaigns: Campaign[]
): Promise<CampaignEmail[]> {
  const results = await Promise.all(
    campaigns.map((campaign) => api.getCampaignEmails(campaign.id))
  );
  return results.flat();
}
