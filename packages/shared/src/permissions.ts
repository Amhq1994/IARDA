// Permission catalogue and seeded role → permission matrix.
// Source of truth: docs/wms/01-design.md §2.2. The database is seeded from this file;
// System Admins can then adjust the matrix at runtime (every change is audited).

export const PERMISSIONS = {
  // administration
  "admin.users": { ar: "إدارة المستخدمين والأدوار", en: "Manage users & role assignments" },
  "admin.roles": { ar: "تعديل مصفوفة الصلاحيات", en: "Edit role–permission matrix" },
  "admin.settings": { ar: "إعدادات النظام", en: "System settings" },
  "admin.workflows": { ar: "مسارات العمل ومصفوفة التفويض", en: "Workflows & DoA matrix" },
  "admin.delegations": { ar: "سجل التفويضات", en: "Delegations register" },
  "delegation.own": { ar: "تفويض صلاحياتي أثناء الغياب", en: "Delegate my approvals during absence" },
  "audit.read": { ar: "سجل التدقيق", en: "Audit trail" },
  // master data
  "item.read": { ar: "عرض الأصناف", en: "View items" },
  "item.manage": { ar: "إنشاء وتعديل الأصناف", en: "Create & edit items" },
  "item.request": { ar: "طلب إنشاء صنف جديد", en: "Request new item" },
  "item.approve": { ar: "اعتماد الأصناف الجديدة", en: "Approve new items" },
  "item.policy": { ar: "حدود المخزون (أدنى/أعلى/إعادة الطلب)", en: "Stock policies (min/max/ROP)" },
  "category.manage": { ar: "إدارة التصنيفات ووحدات القياس", en: "Manage categories & UoM" },
  "warehouse.read": { ar: "عرض هيكل المستودعات", en: "View warehouse structure" },
  "warehouse.manage": { ar: "إدارة هيكل المستودعات", en: "Manage warehouse structure" },
  "supplier.read": { ar: "عرض الموردين", en: "View suppliers" },
  "supplier.manage": { ar: "إدارة الموردين", en: "Manage suppliers" },
  // inbound
  "po.read": { ar: "عرض أوامر الشراء", en: "View purchase orders" },
  "po.manage": { ar: "إدارة أوامر الشراء", en: "Manage purchase orders" },
  "asn.read": { ar: "عرض إشعارات الشحن", en: "View ASNs" },
  "asn.submit": { ar: "تقديم إشعار شحن", en: "Submit ASN" },
  "receipt.execute": { ar: "الاستلام وفحص الكميات", en: "Receive & quantity check" },
  "inspection.execute": { ar: "الفحص الفني (قبول/رفض)", en: "Technical inspection" },
  "grn.post": { ar: "ترحيل سند الاستلام", en: "Post GRN" },
  "grn.approve": { ar: "اعتماد سند الاستلام", en: "Approve GRN" },
  "putaway.execute": { ar: "التخزين الموجّه", en: "Directed put-away" },
  "invoice.manage": { ar: "الفواتير والمطابقة الثلاثية", en: "Invoices & 3-way match" },
  // outbound & requests
  "request.create": { ar: "إنشاء طلبات المواد", en: "Create material requests" },
  "request.approve": { ar: "اعتماد طلبات المواد", en: "Approve material requests" },
  "issue.execute": { ar: "الحجز والتجهيز والصرف", en: "Reserve, pick & issue" },
  "pick.execute": { ar: "تنفيذ التجهيز (جوال)", en: "Execute picking (mobile)" },
  "delivery.confirm": { ar: "تأكيد الاستلام والتوقيع", en: "Confirm receipt & e-sign" },
  // transfers & returns
  "transfer.bin": { ar: "النقل بين المواقع", en: "Bin-to-bin transfer" },
  "transfer.request": { ar: "طلب نقل بين المستودعات", en: "Request inter-warehouse transfer" },
  "transfer.approve": { ar: "اعتماد النقل بين المستودعات", en: "Approve inter-warehouse transfer" },
  "return.warehouse": { ar: "الإرجاع للمستودع", en: "Return to warehouse" },
  "return.vendor": { ar: "الإرجاع للمورد", en: "Return to vendor" },
  "return.vendor.approve": { ar: "اعتماد الإرجاع للمورد", en: "Approve return to vendor" },
  // counting, adjustment, disposal
  "count.plan": { ar: "خطط الجرد", en: "Count plans" },
  "count.execute": { ar: "تنفيذ الجرد", en: "Perform counts" },
  "count.review": { ar: "مراجعة الفروقات وإعادة الجرد", en: "Variance review & recount" },
  "adjustment.request": { ar: "طلب تسوية", en: "Request adjustment" },
  "adjustment.approve": { ar: "اعتماد التسويات", en: "Approve adjustments" },
  "disposal.recommend": { ar: "التوصية بالإتلاف/الشطب", en: "Recommend write-off / disposal" },
  "disposal.approve": { ar: "اعتماد الإتلاف/الشطب", en: "Approve write-off / disposal" },
  // planning, valuation, custody
  "planning.manage": { ar: "التخطيط وإعادة التموين", en: "Planning & replenishment" },
  "pr.create": { ar: "إنشاء طلبات الشراء", en: "Create purchase requisitions" },
  "pr.approve": { ar: "اعتماد طلبات الشراء", en: "Approve purchase requisitions" },
  "pr.process": { ar: "معالجة طلبات الشراء وربطها بأوامر الشراء", en: "Process requisitions & link POs" },
  "valuation.manage": { ar: "التقييم والمخصصات", en: "Valuation & provisions" },
  "journal.manage": { ar: "القيود المحاسبية والمطابقة", en: "Journal entries & reconciliation" },
  "custody.manage": { ar: "إدارة العهد والأصول", en: "Manage custody & assets" },
  "custody.approve": { ar: "اعتماد العهد وإخلاء الطرف", en: "Approve custody & clearance" },
  "clearance.request": { ar: "طلب إخلاء طرف", en: "Request employee clearance" },
  // insight
  "dashboard.view": { ar: "لوحة المعلومات", en: "Dashboard" },
  "report.view": { ar: "التقارير", en: "Reports" },
  "report.export": { ar: "تصدير التقارير", en: "Export reports" },
  "mobile.tasks": { ar: "مهام الجوال", en: "Mobile tasks" },
} as const;

export type Permission = keyof typeof PERMISSIONS;

/** Data scope a role's permissions apply to. */
export type Scope = "all" | "warehouse" | "department" | "own" | "supplier" | "tasks";

export const ROLES = {
  ADM: { ar: "مدير النظام", en: "System Admin", scope: "all" },
  WM: { ar: "مدير المستودع", en: "Warehouse Manager", scope: "warehouse" },
  SK: { ar: "أمين المستودع", en: "Storekeeper", scope: "warehouse" },
  WW: { ar: "عامل المستودع", en: "Warehouse Worker", scope: "tasks" },
  MDO: { ar: "مسؤول البيانات الرئيسية", en: "Master Data Officer", scope: "all" },
  PLN: { ar: "مخطط المخزون", en: "Inventory Planner", scope: "warehouse" },
  REQ: { ar: "طالب المواد", en: "Requester", scope: "own" },
  DM: { ar: "مدير الإدارة", en: "Department Manager", scope: "department" },
  IRC: { ar: "لجنة الفحص والاستلام", en: "Inspection & Receiving Committee", scope: "warehouse" },
  CDC: { ar: "لجنة الجرد والإتلاف", en: "Count & Disposal Committee", scope: "warehouse" },
  PRC: { ar: "المشتريات", en: "Procurement", scope: "all" },
  FIN: { ar: "المالية", en: "Finance", scope: "all" },
  AUD: { ar: "المراجع الداخلي", en: "Internal Auditor", scope: "all" },
  SUP: { ar: "المورد", en: "Supplier", scope: "supplier" },
} as const satisfies Record<string, { ar: string; en: string; scope: Scope }>;

export type RoleCode = keyof typeof ROLES;

const READ_MASTER: Permission[] = ["item.read", "warehouse.read", "supplier.read", "dashboard.view"];

/** Seeded matrix (docs/wms/01-design.md §2.2). Read-only grants are explicit. */
export const ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
  ADM: ["admin.users", "admin.roles", "admin.settings", "admin.workflows", "admin.delegations", "audit.read",
    "warehouse.read", "warehouse.manage", "supplier.read", "supplier.manage", "item.read", "dashboard.view", "report.view"],
  WM: [...READ_MASTER, "item.request", "item.approve", "warehouse.manage", "po.read", "asn.read", "grn.approve",
    "request.create", "request.approve", "transfer.bin", "transfer.request", "transfer.approve", "return.vendor.approve",
    "count.plan", "count.review", "adjustment.request", "adjustment.approve", "disposal.approve", "pr.approve",
    "custody.approve", "delegation.own", "audit.read", "report.view", "report.export"],
  SK: [...READ_MASTER, "item.request", "po.read", "asn.read", "receipt.execute", "grn.post", "putaway.execute",
    "request.create", "issue.execute", "pick.execute", "transfer.bin", "transfer.request", "return.warehouse",
    "return.vendor", "adjustment.request", "custody.manage", "clearance.request", "mobile.tasks", "report.view", "report.export"],
  WW: ["item.read", "warehouse.read", "receipt.execute", "putaway.execute", "pick.execute", "transfer.bin",
    "return.warehouse", "count.execute", "mobile.tasks"],
  MDO: [...READ_MASTER, "item.manage", "item.request", "category.manage", "report.view"],
  PLN: [...READ_MASTER, "item.request", "item.policy", "po.read", "transfer.request", "count.plan", "planning.manage",
    "pr.create", "report.view", "report.export"],
  REQ: ["item.read", "dashboard.view", "item.request", "request.create", "delivery.confirm", "return.warehouse"],
  DM: ["item.read", "dashboard.view", "item.request", "request.create", "request.approve", "delivery.confirm",
    "return.warehouse", "custody.approve", "delegation.own", "report.view"],
  IRC: [...READ_MASTER, "po.read", "asn.read", "inspection.execute", "delegation.own", "report.view"],
  CDC: [...READ_MASTER, "count.execute", "count.review", "adjustment.request", "disposal.recommend", "delegation.own",
    "mobile.tasks", "report.view"],
  PRC: [...READ_MASTER, "item.request", "supplier.manage", "po.read", "po.manage", "asn.read", "invoice.manage",
    "return.vendor", "pr.process", "report.view"],
  FIN: [...READ_MASTER, "po.read", "invoice.manage", "disposal.approve", "valuation.manage", "journal.manage",
    "delegation.own", "audit.read", "report.view", "report.export"],
  AUD: [...READ_MASTER, "po.read", "asn.read", "audit.read", "admin.delegations", "report.view", "report.export"],
  SUP: ["po.read", "asn.read", "asn.submit"],
};

/** Roles that may never post stock transactions (enforced by the posting engine). */
export const NO_TRANSACTION_ROLES: RoleCode[] = ["ADM", "MDO", "FIN", "AUD", "SUP"];
