import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Me } from "@scottylabs-invites/contract";
import { api, unwrap } from "./api";

interface AuthState {
  me: Me;
  loading: boolean;
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthState>({
  me: { user: null, admin: null },
  loading: true,
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["me"],
    queryFn: async () => unwrap(await api.auth.me(), 200),
    staleTime: 60_000,
    retry: 1,
  });

  return (
    <AuthContext.Provider
      value={{
        me: query.data ?? { user: null, admin: null },
        loading: query.isLoading,
        refresh: () => qc.invalidateQueries({ queryKey: ["me"] }),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
