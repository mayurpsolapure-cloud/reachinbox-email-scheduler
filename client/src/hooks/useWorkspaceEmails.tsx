import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, fetchAllCampaignEmails } from "../services/api";
import type { Campaign, CampaignEmail } from "../types";
import { errorMessage } from "../utils";

type WorkspaceEmailData = {
  campaigns: Campaign[];
  emails: CampaignEmail[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
};

const WorkspaceEmailsContext = createContext<WorkspaceEmailData | null>(null);

export function WorkspaceEmailsProvider({ children }: { children: ReactNode }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [emails, setEmails] = useState<CampaignEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const allCampaigns = await api.getCampaigns();
      const allEmails = await fetchAllCampaignEmails(allCampaigns);
      setCampaigns(allCampaigns);
      setEmails(allEmails);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo(
    () => ({ campaigns, emails, loading, error, reload }),
    [campaigns, emails, loading, error, reload]
  );
  return <WorkspaceEmailsContext.Provider value={value}>{children}</WorkspaceEmailsContext.Provider>;
}

export function useWorkspaceEmails() {
  const context = useContext(WorkspaceEmailsContext);
  if (!context) throw new Error("useWorkspaceEmails must be used inside WorkspaceEmailsProvider");
  return context;
}
