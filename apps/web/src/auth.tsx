import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { applyLang } from "./i18n";

export interface Me {
  id: string; username: string; nameAr: string; nameEn: string; orgUnitId: string | null; supplierId: string | null;
  lang: "ar" | "en"; mfaEnabled: boolean; mustChangePassword: boolean;
  roles: { code: string; scope: string; warehouseIds: string[] | null; orgUnitIds: string[] | null }[];
  permissions: string[];
}

interface AuthCtx { me: Me | null; loading: boolean; can: (...perms: string[]) => boolean; refresh: () => Promise<unknown>; logout: () => Promise<void> }

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ user: Me }>("/api/auth/me").then((r) => r.user).catch(() => null),
    staleTime: 60_000,
  });
  const me = q.data ?? null;

  useEffect(() => {
    const onUnauth = () => qc.setQueryData(["me"], null);
    window.addEventListener("wms:unauthenticated", onUnauth);
    return () => window.removeEventListener("wms:unauthenticated", onUnauth);
  }, [qc]);

  const value: AuthCtx = {
    me,
    loading: q.isLoading,
    can: (...perms) => !!me && perms.some((p) => me.permissions.includes(p)),
    refresh: () => qc.invalidateQueries({ queryKey: ["me"] }),
    logout: async () => {
      await api.post("/api/auth/logout").catch(() => {});
      qc.clear();
      qc.setQueryData(["me"], null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export function setLanguage(lang: "ar" | "en", persist: boolean) {
  applyLang(lang);
  if (persist) api.patch("/api/auth/me", { lang }).catch(() => {});
}
