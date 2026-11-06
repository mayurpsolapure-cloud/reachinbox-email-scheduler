import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, api } from "../services/api";
import type { AuthenticatedUser } from "../services/api";
import { errorMessage } from "../utils";

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error";
type AuthContextValue = {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  error: string;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      setUser(await api.getCurrentUser());
      setStatus("authenticated");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setUser(null);
        setStatus("unauthenticated");
        return;
      }
      setError(errorMessage(reason));
      setStatus("error");
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setStatus("unauthenticated");
    setError("");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ status, user, error, refresh, logout }),
    [status, user, error, refresh, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
