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
import { RequestsPage, RequestFormPage, RequestDetailPage, DeliveryNotePage } from "./pages/Requests";
import { ReceiptsPage, ReceiptDetailPage, PurchaseOrdersPage, PurchaseOrderDetailPage } from "./pages/Inbound";
import { StockPage } from "./pages/Stock";
import { MobileHome, MobilePutawayList, MobilePutawayTask, MobilePickLists, MobilePickList, MobileLookup, MobileCountList, MobileCount, MobileMove } from "./pages/Mobile";
import { PlanningPage, PrsPage, PrDetailPage, ValuationPage, JournalDetailPage, ProvisionDetailPage, CustodyPage, ClearancesPage, ClearanceDetailPage } from "./pages/Planning";
import { KpisPage, ReportsPage, IntegrationsPage, LabelsPage, PortalPage } from "./pages/Insights";
import { ApprovalsPage, TransfersPage, TransferDetailPage, ReturnsPage, ReturnDetailPage, CountsPage, CountDetailPage, AdjustmentsPage, AdjustmentDetailPage, DisposalsPage, DisposalDetailPage } from "./pages/Control";

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
  { path: "/m", element: <RequireAuth><MobileHome /></RequireAuth> },
  { path: "/m/putaway", element: <RequireAuth><MobilePutawayList /></RequireAuth> },
  { path: "/m/putaway/:id", element: <RequireAuth><MobilePutawayTask /></RequireAuth> },
  { path: "/m/pick", element: <RequireAuth><MobilePickLists /></RequireAuth> },
  { path: "/m/pick/:id", element: <RequireAuth><MobilePickList /></RequireAuth> },
  { path: "/m/lookup", element: <RequireAuth><MobileLookup /></RequireAuth> },
  { path: "/m/count", element: <RequireAuth><MobileCountList /></RequireAuth> },
  { path: "/m/count/:id", element: <RequireAuth><MobileCount /></RequireAuth> },
  { path: "/m/move", element: <RequireAuth><MobileMove /></RequireAuth> },
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
      { path: "requests", element: <Guard perms={["request.create", "request.approve", "issue.execute", "audit.read", "delegation.own"]}><RequestsPage /></Guard> },
      { path: "requests/new", element: <Guard perms={["request.create"]}><RequestFormPage /></Guard> },
      { path: "requests/:id", element: <RequestDetailPage /> },
      { path: "requests/:id/edit", element: <Guard perms={["request.create"]}><RequestFormPage /></Guard> },
      { path: "delivery-notes/:id", element: <DeliveryNotePage /> },
      { path: "inbound/receipts", element: <Guard perms={["receipt.execute", "inspection.execute", "grn.post", "po.read"]}><ReceiptsPage /></Guard> },
      { path: "inbound/receipts/:id", element: <ReceiptDetailPage /> },
      { path: "inbound/pos", element: <Guard perms={["po.read"]}><PurchaseOrdersPage /></Guard> },
      { path: "inbound/pos/:id", element: <Guard perms={["po.read"]}><PurchaseOrderDetailPage /></Guard> },
      { path: "stock", element: <Guard perms={["warehouse.read"]}><StockPage /></Guard> },
      { path: "approvals", element: <ApprovalsPage /> },
      { path: "transfers", element: <Guard perms={["transfer.request", "transfer.approve", "issue.execute", "receipt.execute", "audit.read"]}><TransfersPage /></Guard> },
      { path: "transfers/:id", element: <TransferDetailPage /> },
      { path: "returns", element: <Guard perms={["return.warehouse", "return.vendor", "return.vendor.approve", "issue.execute", "audit.read"]}><ReturnsPage /></Guard> },
      { path: "returns/:id", element: <ReturnDetailPage /> },
      { path: "counts", element: <Guard perms={["count.plan", "count.execute", "count.review", "audit.read"]}><CountsPage /></Guard> },
      { path: "counts/:id", element: <CountDetailPage /> },
      { path: "adjustments", element: <Guard perms={["adjustment.request", "adjustment.approve", "count.review", "valuation.manage", "audit.read"]}><AdjustmentsPage /></Guard> },
      { path: "adjustments/:id", element: <AdjustmentDetailPage /> },
      { path: "disposals", element: <Guard perms={["disposal.recommend", "disposal.approve", "adjustment.request", "audit.read"]}><DisposalsPage /></Guard> },
      { path: "disposals/:id", element: <DisposalDetailPage /> },
      { path: "planning", element: <Guard perms={["planning.manage", "pr.create", "pr.approve", "valuation.manage", "audit.read"]}><PlanningPage /></Guard> },
      { path: "planning/prs", element: <Guard perms={["pr.create", "pr.approve", "pr.process", "planning.manage", "audit.read"]}><PrsPage /></Guard> },
      { path: "planning/prs/:id", element: <PrDetailPage /> },
      { path: "valuation", element: <Guard perms={["valuation.manage", "journal.manage", "audit.read"]}><ValuationPage /></Guard> },
      { path: "valuation/journals/:id", element: <Guard perms={["valuation.manage", "journal.manage", "audit.read"]}><JournalDetailPage /></Guard> },
      { path: "valuation/provisions/:id", element: <Guard perms={["valuation.manage", "journal.manage", "audit.read"]}><ProvisionDetailPage /></Guard> },
      { path: "custody", element: <CustodyPage /> },
      { path: "clearances", element: <Guard perms={["clearance.request", "admin.users", "audit.read"]}><ClearancesPage /></Guard> },
      { path: "clearances/:id", element: <ClearanceDetailPage /> },
      { path: "kpis", element: <Guard perms={["dashboard.view", "report.view"]}><KpisPage /></Guard> },
      { path: "reports", element: <Guard perms={["report.view", "report.export"]}><ReportsPage /></Guard> },
      { path: "admin/integrations", element: <Guard perms={["admin.settings", "audit.read"]}><IntegrationsPage /></Guard> },
      { path: "labels", element: <Guard perms={["warehouse.read"]}><LabelsPage /></Guard> },
      { path: "portal", element: <Guard perms={["asn.read", "po.read"]}><PortalPage /></Guard> },
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
