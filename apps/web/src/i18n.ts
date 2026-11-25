import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { opsAr, opsEn } from "./i18n-ops";
import { invAr, invEn, invEventsAr, invEventsEn } from "./i18n-inv";
import { p45Ar, p45En, p45EventsAr, p45EventsEn } from "./i18n-p45";

const ar = {
  app: { name: "نظام إدارة المستودعات ومراقبة المخزون", short: "إدارة المستودعات", org: "هيئة تطوير محمية الإمام عبدالعزيز بن محمد الملكية",
    copyright: "© {{year}} جميع الحقوق محفوظة", switchLang: "English" },
  nav: { main: "الرئيسية", dashboard: "لوحة المعلومات", masterData: "البيانات الرئيسية", items: "الأصناف", newItem: "صنف جديد",
    catalog: "التصنيفات ووحدات القياس", warehouses: "المستودعات", suppliers: "الموردون", admin: "الإدارة", users: "المستخدمون",
    roles: "مصفوفة الصلاحيات", settings: "الإعدادات", audit: "سجل التدقيق", profile: "ملفي", logout: "تسجيل الخروج", menu: "القائمة",
    comingSoon: "قريباً", operations: "العمليات", inbound: "الوارد والاستلام", outbound: "طلبات المواد والصرف", counting: "الجرد",
    planning: "التخطيط والتقييم" },
  login: { hello: "مرحباً بك", sub: "سجّل الدخول للمتابعة إلى نظام إدارة المستودعات", username: "اسم المستخدم", password: "كلمة المرور",
    totp: "رمز التحقق (6 أرقام)", submit: "تسجيل الدخول", sso: "الدخول عبر الدخول الموحد (Azure AD)", or: "أو",
    heroTitle: "مخزون دقيق لحماية مستدامة", heroText: "إدارة متكاملة للأصناف والمستودعات والطلبات والجرد، وفق ضوابط الهيئة الوطنية للأمن السيبراني ونظام حماية البيانات الشخصية.",
    demo: "حسابات العرض التجريبي", demoHint: "كلمة المرور لجميع الحسابات" },
  common: { search: "بحث", filter: "تصفية", all: "الكل", save: "حفظ", cancel: "إلغاء", close: "إغلاق", edit: "تعديل", create: "إنشاء",
    add: "إضافة", delete: "حذف", confirm: "تأكيد", back: "رجوع", loading: "جارٍ التحميل…", empty: "لا توجد بيانات", yes: "نعم", no: "لا",
    actions: "الإجراءات", status: "الحالة", code: "الرمز", nameAr: "الاسم بالعربية", nameEn: "الاسم بالإنجليزية", name: "الاسم",
    details: "التفاصيل", history: "السجل", reason: "السبب", of: "من", page: "صفحة", results: "نتيجة", required: "مطلوب",
    saved: "تم الحفظ", error: "حدث خطأ", createdBy: "أنشأه", updatedAt: "آخر تحديث", type: "النوع", notes: "ملاحظات", none: "—",
    view: "عرض", warehouse: "المستودع", version: "الإصدار", total: "الإجمالي", reload: "تحديث", optional: "اختياري" },
  item: { title: "الأصناف", code: "رمز الصنف", category: "التصنيف", group: "المجموعة", type: "نوع الصنف", uom: "وحدة القياس الأساسية",
    tracking: "التتبع", batch: "دفعة", serial: "رقم تسلسلي", expiry: "تاريخ صلاحية", shelfLife: "مدة الصلاحية (يوم)",
    weight: "الوزن للوحدة (كجم)", volume: "الحجم للوحدة (م³)", hazard: "فئة الخطورة", storage: "ظروف التخزين", ved: "تصنيف VED",
    abc: "ABC", xyz: "XYZ", cost: "التكلفة المعيارية (ر.س)", description: "الوصف", specs: "المواصفات الفنية",
    identifiers: "المعرّفات (باركود / QR / RFID)", conversions: "تحويلات وحدات القياس", substitutes: "الأصناف البديلة",
    policies: "حدود المخزون حسب المستودع", images: "الصور", factor: "المعامل إلى الوحدة الأساسية", min: "الحد الأدنى", max: "الحد الأعلى",
    rop: "نقطة إعادة الطلب", safety: "مخزون الأمان", leadTime: "مدة التوريد (يوم)", pickingRule: "قاعدة الصرف",
    newTitle: "صنف جديد", requestTitle: "طلب إنشاء صنف جديد", editTitle: "تعديل الصنف",
    duplicatesTitle: "أصناف مشابهة", duplicatesHint: "تحقق من عدم وجود الصنف مسبقاً قبل الإنشاء", similarity: "التشابه",
    acknowledge: "راجعت الأصناف المشابهة وأؤكد أن هذا صنف مختلف", submit: "رفع للاعتماد", approve: "اعتماد", reject: "رفض وإعادة",
    block: "إيقاف", unblock: "إعادة تفعيل", obsolete: "تقادم", requestedBy: "طلبه", approvedBy: "اعتمده",
    uploadImage: "رفع صورة", primary: "رئيسية", addIdentifier: "إضافة معرّف", addConversion: "إضافة تحويل", addSubstitute: "إضافة بديل",
    ratio: "النسبة", priority: "الأولوية", value: "القيمة", idType: "نوع المعرّف", manufacturer: "المصنّع", setPolicy: "تحديد الحدود",
    pendingMine: "بانتظار اعتمادي", myRequests: "طلباتي", scan: "مسح باركود", lookupHint: "أدخل أو امسح الباركود / رمز الصنف" },
  wh: { title: "المستودعات", zones: "المناطق", aisles: "ممرات", racks: "رفوف", bins: "خانات", capacity: "السعة", used: "المستخدم",
    utilization: "نسبة الإشغال", structure: "هيكل المستودع", generate: "توليد الممرات والرفوف والخانات", aislesN: "عدد الممرات",
    racksN: "رفوف لكل ممر", binsN: "خانات لكل رف", startAisle: "رقم أول ممر", binWeight: "أقصى وزن للخانة (كجم)",
    binVolume: "أقصى حجم للخانة (م³)", blocked: "موقوف", block: "إيقاف الموقع", unblock: "إعادة تفعيل", manager: "المدير",
    city: "المدينة", type: "نوع المستودع", pickingRule: "قاعدة الصرف الافتراضية", fullCode: "رمز الموقع", level: "المستوى",
    velocity: "سرعة الدوران", children: "مواقع فرعية", generated: "تم إنشاء {{n}} موقعاً", locate: "بحث عن موقع", newWarehouse: "مستودع جديد",
    maxWeight: "أقصى وزن (كجم)", maxVolume: "أقصى حجم (م³)", hazmat: "يسمح بالمواد الخطرة", temp: "مكيّف الحرارة" },
  admin: { users: "المستخدمون", newUser: "مستخدم جديد", username: "اسم الدخول", employeeNo: "الرقم الوظيفي", email: "البريد الإلكتروني",
    mobile: "الجوال", department: "الإدارة", position: "المسمى الوظيفي", roles: "الأدوار", lastLogin: "آخر دخول", mfa: "المصادقة الثنائية",
    assignRole: "إسناد دور", scopeWarehouses: "نطاق المستودعات (فارغ = الكل)", revoke: "سحب", unlock: "فك القفل", resetPassword: "إعادة تعيين كلمة المرور",
    tempPassword: "كلمة المرور المؤقتة (تظهر مرة واحدة)", matrix: "مصفوفة الأدوار والصلاحيات", permission: "الصلاحية", locked: "مقفل",
    settings: "إعدادات النظام", value: "القيمة", sodNote: "لا يمكن منح صلاحيات حركات المخزون لأدوار مدير النظام والمراجع والمالية والمورد ومسؤول البيانات (فصل المهام)." },
  audit: { title: "سجل التدقيق", verify: "التحقق من سلامة السجل", intact: "السجل سليم — تم التحقق من {{n}} قيداً", broken: "تم اكتشاف عبث عند القيد رقم {{id}}",
    at: "الوقت", actor: "المستخدم", action: "الإجراء", table: "الجدول", fields: "الحقول المعدلة", before: "قبل", after: "بعد",
    security: "أحداث الأمان", event: "الحدث", ip: "عنوان IP", INSERT: "إنشاء", UPDATE: "تعديل", DELETE: "حذف" },
  profile: { title: "ملفي", changePassword: "تغيير كلمة المرور", current: "كلمة المرور الحالية", newPw: "كلمة المرور الجديدة",
    policy: "10 أحرف على الأقل، حرف كبير وصغير ورقم ورمز", mfaTitle: "المصادقة الثنائية (TOTP)", mfaOn: "مفعّلة", mfaOff: "غير مفعّلة",
    mfaSetup: "تفعيل المصادقة الثنائية", mfaScan: "امسح الرمز بتطبيق المصادقة ثم أدخل الرمز المكوّن من 6 أرقام", mfaEnable: "تأكيد التفعيل",
    language: "لغة الواجهة", myRoles: "أدواري وصلاحياتي" },
  dash: { welcome: "مرحباً، {{name}}", activeItems: "أصناف نشطة", pending: "بانتظار الاعتماد", drafts: "مسودات وطلبات", blocked: "موقوفة",
    bins: "خانات التخزين", dataQuality: "جودة البيانات الرئيسية", noBarcode: "بدون باركود", noImage: "بدون صورة", noDims: "بدون أبعاد/وزن",
    noVed: "بدون تصنيف VED", byCategory: "الأصناف حسب التصنيف", recent: "آخر النشاطات", security: "مؤشرات الأمان", activeUsers: "مستخدمون نشطون",
    lockedUsers: "حسابات مقفلة", failed24: "محاولات دخول فاشلة (24 ساعة)", withoutMfa: "بدون مصادقة ثنائية", phaseNote: "مؤشرات المخزون (الدقة، معدل التلبية، دورة الطلب…) تظهر بعد تفعيل حركات المخزون في المرحلة الثانية.",
    kpis: "مؤشرات الأداء المستهدفة", myRequests: "طلبات الأصناف الخاصة بي" },
  errors: { forbidden: "لا تملك صلاحية الوصول إلى هذه الصفحة", notFound: "الصفحة غير موجودة" },
};

type Dict = typeof ar;

const en: Dict = {
  app: { name: "Warehouse Management & Inventory Control", short: "Warehouse Management", org: "Imam Abdulaziz bin Mohammed Royal Reserve Development Authority",
    copyright: "© {{year}} All rights reserved", switchLang: "العربية" },
  nav: { main: "Main", dashboard: "Dashboard", masterData: "Master data", items: "Items", newItem: "New item", catalog: "Categories & UoM",
    warehouses: "Warehouses", suppliers: "Suppliers", admin: "Administration", users: "Users", roles: "Permission matrix", settings: "Settings",
    audit: "Audit trail", profile: "My profile", logout: "Sign out", menu: "Menu", comingSoon: "Coming soon", operations: "Operations",
    inbound: "Inbound & receiving", outbound: "Material requests & issue", counting: "Counting", planning: "Planning & valuation" },
  login: { hello: "Welcome", sub: "Sign in to continue to the Warehouse Management System", username: "Username", password: "Password",
    totp: "Verification code (6 digits)", submit: "Sign in", sso: "Sign in with SSO (Azure AD)", or: "or",
    heroTitle: "Accurate inventory for sustainable protection", heroText: "Integrated management of items, warehouses, requests and counts — aligned with NCA cybersecurity controls and the PDPL.",
    demo: "Demo accounts", demoHint: "Password for all accounts" },
  common: { search: "Search", filter: "Filter", all: "All", save: "Save", cancel: "Cancel", close: "Close", edit: "Edit", create: "Create",
    add: "Add", delete: "Delete", confirm: "Confirm", back: "Back", loading: "Loading…", empty: "No data", yes: "Yes", no: "No",
    actions: "Actions", status: "Status", code: "Code", nameAr: "Arabic name", nameEn: "English name", name: "Name", details: "Details",
    history: "History", reason: "Reason", of: "of", page: "Page", results: "results", required: "Required", saved: "Saved", error: "Error",
    createdBy: "Created by", updatedAt: "Last updated", type: "Type", notes: "Notes", none: "—", view: "View", warehouse: "Warehouse",
    version: "Version", total: "Total", reload: "Refresh", optional: "optional" },
  item: { title: "Items", code: "Item code", category: "Category", group: "Group", type: "Item type", uom: "Base unit of measure",
    tracking: "Tracking", batch: "Batch", serial: "Serial", expiry: "Expiry", shelfLife: "Shelf life (days)", weight: "Unit weight (kg)",
    volume: "Unit volume (m³)", hazard: "Hazard class", storage: "Storage conditions", ved: "VED class", abc: "ABC", xyz: "XYZ",
    cost: "Standard cost (SAR)", description: "Description", specs: "Technical specifications", identifiers: "Identifiers (barcode / QR / RFID)",
    conversions: "Unit conversions", substitutes: "Substitute items", policies: "Stock limits by warehouse", images: "Images",
    factor: "Factor to base unit", min: "Min", max: "Max", rop: "Reorder point", safety: "Safety stock", leadTime: "Lead time (days)",
    pickingRule: "Picking rule", newTitle: "New item", requestTitle: "New item request", editTitle: "Edit item",
    duplicatesTitle: "Similar items", duplicatesHint: "Make sure the item does not already exist before creating it", similarity: "Similarity",
    acknowledge: "I reviewed the similar items and confirm this is a different item", submit: "Submit for approval", approve: "Approve",
    reject: "Reject & return", block: "Block", unblock: "Unblock", obsolete: "Mark obsolete", requestedBy: "Requested by", approvedBy: "Approved by",
    uploadImage: "Upload image", primary: "Primary", addIdentifier: "Add identifier", addConversion: "Add conversion", addSubstitute: "Add substitute",
    ratio: "Ratio", priority: "Priority", value: "Value", idType: "Identifier type", manufacturer: "Manufacturer", setPolicy: "Set limits",
    pendingMine: "Awaiting my approval", myRequests: "My requests", scan: "Scan barcode", lookupHint: "Type or scan a barcode / item code" },
  wh: { title: "Warehouses", zones: "Zones", aisles: "Aisles", racks: "Racks", bins: "Bins", capacity: "Capacity", used: "Used",
    utilization: "Utilisation", structure: "Warehouse structure", generate: "Generate aisles, racks and bins", aislesN: "Aisles",
    racksN: "Racks per aisle", binsN: "Bins per rack", startAisle: "First aisle number", binWeight: "Max bin weight (kg)",
    binVolume: "Max bin volume (m³)", blocked: "Blocked", block: "Block location", unblock: "Unblock", manager: "Manager", city: "City",
    type: "Warehouse type", pickingRule: "Default picking rule", fullCode: "Location code", level: "Level", velocity: "Velocity",
    children: "Children", generated: "{{n}} locations created", locate: "Find location", newWarehouse: "New warehouse",
    maxWeight: "Max weight (kg)", maxVolume: "Max volume (m³)", hazmat: "Hazmat allowed", temp: "Temperature controlled" },
  admin: { users: "Users", newUser: "New user", username: "Username", employeeNo: "Employee no.", email: "Email", mobile: "Mobile",
    department: "Department", position: "Position", roles: "Roles", lastLogin: "Last login", mfa: "MFA", assignRole: "Assign role",
    scopeWarehouses: "Warehouse scope (empty = all)", revoke: "Revoke", unlock: "Unlock", resetPassword: "Reset password",
    tempPassword: "Temporary password (shown once)", matrix: "Role–permission matrix", permission: "Permission", locked: "Locked",
    settings: "System settings", value: "Value", sodNote: "Stock-transaction permissions cannot be granted to System Admin, Auditor, Finance, Supplier or Master Data roles (segregation of duties)." },
  audit: { title: "Audit trail", verify: "Verify integrity", intact: "Intact — {{n}} entries verified", broken: "Tampering detected at entry #{{id}}",
    at: "Time", actor: "User", action: "Action", table: "Table", fields: "Changed fields", before: "Before", after: "After",
    security: "Security events", event: "Event", ip: "IP address", INSERT: "Created", UPDATE: "Updated", DELETE: "Deleted" },
  profile: { title: "My profile", changePassword: "Change password", current: "Current password", newPw: "New password",
    policy: "At least 10 characters with upper, lower, digit and symbol", mfaTitle: "Two-factor authentication (TOTP)", mfaOn: "Enabled",
    mfaOff: "Not enabled", mfaSetup: "Enable two-factor authentication", mfaScan: "Scan the code with your authenticator app, then enter the 6-digit code",
    mfaEnable: "Confirm", language: "Interface language", myRoles: "My roles & permissions" },
  dash: { welcome: "Welcome, {{name}}", activeItems: "Active items", pending: "Pending approval", drafts: "Drafts & requests", blocked: "Blocked",
    bins: "Storage bins", dataQuality: "Master data quality", noBarcode: "No barcode", noImage: "No image", noDims: "No weight/volume",
    noVed: "No VED class", byCategory: "Items by category", recent: "Recent activity", security: "Security indicators", activeUsers: "Active users",
    lockedUsers: "Locked accounts", failed24: "Failed logins (24 h)", withoutMfa: "Without MFA", phaseNote: "Stock KPIs (accuracy, fill rate, cycle time…) appear once stock transactions go live in Phase 2.",
    kpis: "KPI targets", myRequests: "My item requests" },
  errors: { forbidden: "You do not have access to this page", notFound: "Page not found" },
};

const EVENTS_AR: Record<string, string> = {
  created: "إنشاء", submitted: "إرسال", validation_failed: "لم يجتز التحقق", approved: "اعتماد نهائي", approved_l1: "اعتماد المستوى 1", approved_l2: "اعتماد المستوى 2",
  approved_l3: "اعتماد المستوى 3", rejected_l1: "رفض", rejected_l2: "رفض", returned_l1: "إعادة للتعديل", returned_l2: "إعادة للتعديل", reserved: "حجز المخزون",
  pick_list_released: "إصدار قائمة التجهيز", picked: "اكتمال التجهيز", delivered_full: "تسليم كامل", delivered_partial: "تسليم جزئي", closed: "إغلاق",
  short_closed: "إغلاق دون استكمال", cancelled: "إلغاء", overdue: "تجاوز مدة الخدمة",
  arrived: "وصول الشحنة", quantity_checked: "فحص الكميات", inspection_started: "إحالة للجنة الفحص", inspection_recorded: "تسجيل نتائج الفحص",
  inspection_agree: "توقيع عضو: موافق", inspection_object: "توقيع عضو: اعتراض", inspection_completed: "اكتمال الفحص", grn_posted: "ترحيل سند الاستلام",
  putaway_completed: "اكتمال التخزين",
};
const EVENTS_EN: Record<string, string> = {
  created: "Created", submitted: "Submitted", validation_failed: "Failed validation", approved: "Final approval", approved_l1: "Level 1 approved", approved_l2: "Level 2 approved",
  approved_l3: "Level 3 approved", rejected_l1: "Rejected", rejected_l2: "Rejected", returned_l1: "Returned for revision", returned_l2: "Returned for revision",
  reserved: "Stock reserved", pick_list_released: "Pick list released", picked: "Picking completed", delivered_full: "Delivered in full", delivered_partial: "Delivered partially",
  closed: "Closed", short_closed: "Short-closed", cancelled: "Cancelled", overdue: "SLA breached", arrived: "Arrived", quantity_checked: "Quantity checked",
  inspection_started: "Referred to committee", inspection_recorded: "Inspection results recorded", inspection_agree: "Member signed: agree",
  inspection_object: "Member signed: object", inspection_completed: "Inspection completed", grn_posted: "GRN posted", putaway_completed: "Put-away completed",
};

const saved = (() => { try { return localStorage.getItem("wms.lang"); } catch { return null; } })();
const initial = saved === "en" ? "en" : "ar";

i18n.use(initReactI18next).init({
  resources: { ar: { translation: { ...ar, ...opsAr, ...invAr, ...p45Ar, events: { ...p45EventsAr, ...invEventsAr, ...EVENTS_AR } } },
    en: { translation: { ...en, ...opsEn, ...invEn, ...p45En, events: { ...p45EventsEn, ...invEventsEn, ...EVENTS_EN } } } },
  lng: initial,
  fallbackLng: "ar",
  interpolation: { escapeValue: false },
});

export function applyLang(lang: "ar" | "en") {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.title = lang === "ar" ? `${ar.app.short} — ${ar.app.org}` : `${en.app.short} — ${en.app.org}`;
  try { localStorage.setItem("wms.lang", lang); } catch { /* private mode */ }
  if (i18n.language !== lang) i18n.changeLanguage(lang);
}
applyLang(initial);

export default i18n;
