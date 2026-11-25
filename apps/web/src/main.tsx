import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import "../../../brand/css/iarda.css";
import "./app.css";
import "./i18n";
import { AuthProvider, useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { Loading, Empty } from "./components/ui";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { ItemsPage } from "./pages/Items";
import { ItemDetailPage } from "./pages/ItemDetail";
import { ItemFormPage } from "./pages/ItemForm";
import { CatalogPage } from "./pages/Catalog";
import { WarehousesPage, WarehouseDetailPage } from "./pages/Warehouses";
import { SuppliersPage } from "./pages/Suppliers";
import { UsersPage, UserDetailPage } from "./pages/Users";
import { RolesPage } from "./pages/Roles";
import { SettingsPage } from "./pages/Settings";
import { AuditPage } from "./pages/Audit";
import { ProfilePage } from "./pages/Profile";

const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e: any) => n < 1 && !(e?.status >= 400 && e?.status < 500), refetchOnWindowFocus: false } } });

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Guard({ perms, children }: { perms: string[]; children: ReactNode }) {
  const { can } = useAuth();
  const { t } = useTranslation();
  return can(...perms) ? <>{children}</> : <Empty text={t("errors.forbidden")} />;
}

function NotFound() {
  const { t } = useTranslation();
  return <Empty text={t("errors.notFound")} />;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <RequireAuth><Layout /></RequireAuth>,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "items", element: <Guard perms={["item.read"]}><ItemsPage /></Guard> },
      { path: "items/new", element: <Guard perms={["item.manage", "item.request"]}><ItemFormPage /></Guard> },
      { path: "items/:id", element: <Guard perms={["item.read"]}><ItemDetailPage /></Guard> },
      { path: "items/:id/edit", element: <Guard perms={["item.manage"]}><ItemFormPage /></Guard> },
      { path: "catalog", element: <Guard perms={["category.manage", "item.manage"]}><CatalogPage /></Guard> },
      { path: "warehouses", element: <Guard perms={["warehouse.read"]}><WarehousesPage /></Guard> },
      { path: "warehouses/:id", element: <Guard perms={["warehouse.read"]}><WarehouseDetailPage /></Guard> },
      { path: "suppliers", element: <Guard perms={["supplier.read", "supplier.manage"]}><SuppliersPage /></Guard> },
      { path: "users", element: <Guard perms={["admin.users"]}><UsersPage /></Guard> },
      { path: "users/:id", element: <Guard perms={["admin.users", "audit.read"]}><UserDetailPage /></Guard> },
      { path: "roles", element: <Guard perms={["admin.roles", "admin.users", "audit.read"]}><RolesPage /></Guard> },
      { path: "settings", element: <Guard perms={["admin.settings"]}><SettingsPage /></Guard> },
      { path: "audit", element: <Guard perms={["audit.read"]}><AuditPage /></Guard> },
      { path: "profile", element: <ProfilePage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);
