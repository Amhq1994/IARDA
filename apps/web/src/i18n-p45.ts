// Phase 4–5 translations: planning, requisitions, valuation & journals, custody & clearance, KPIs, reports, integrations, labels, portal.
export const p45Ar = {
  pl: {
    planning: "التخطيط وإعادة الطلب", runs: "تشغيلات التخطيط", newRun: "تشغيل التخطيط الآن", run: "التشغيل", lines: "البنود", reorderValue: "قيمة إعادة الطلب",
    action: "التوصية", reorder: "إعادة طلب", ok: "ضمن الحدود", excess: "فائض", dead: "راكد", no_demand: "لا طلب", demand: "الطلب اليومي",
    forecast: "توقع 30 يوماً", ss: "مخزون الأمان", rop: "نقطة إعادة الطلب", eoq: "الكمية الاقتصادية", minmax: "الحد الأدنى / الأعلى", current: "الحالي",
    proposed: "المقترح", free: "المتاح", onOrder: "تحت الطلب", suggested: "الكمية المقترحة", lt: "مدة التوريد", apply: "اعتماد المعاملات في سياسات الأصناف",
    createPrs: "إنشاء طلبات شراء", selected: "المحدد", deadStock: "المخزون الراكد وبطيء الحركة", idleDays: "أيام دون صرف", slow: "بطيء الحركة",
    formula: "مخزون الأمان = z × σ × √مدة التوريد · نقطة إعادة الطلب = الطلب اليومي × مدة التوريد + مخزون الأمان · EOQ = √(2DS/Hc)",
    prs: "طلبات الشراء", pr: "طلب الشراء", newPr: "طلب شراء يدوي", source: "المصدر", auto: "آلي", manual: "يدوي", convert: "تحويل إلى أمر شراء",
    estCost: "التكلفة التقديرية", po: "أمر الشراء", cancel: "إلغاء", etimadRef: "مرجع الترسية في منصة اعتماد", expected: "التاريخ المتوقع", unitPrice: "سعر الوحدة",
  },
  val: {
    valuation: "التقييم والقيود", summary: "ملخص التقييم", method: "طريقة التقييم الدفترية", wavg: "متوسط مرجح", fifo: "FIFO (للمقارنة)", ledger: "سجل الحركات",
    gl: "الأستاذ العام", unjournalised: "غير مقيّد بعد", reconciled: "مطابق", notReconciled: "يوجد فرق", provision: "مخصص التقادم", items: "تقييم الأصناف",
    provisions: "المخصصات", runProvision: "احتساب المخصص", required: "المخصص المطلوب", previous: "الرصيد السابق", delta: "قيد الفرق", category: "الفئة",
    expired: "منتهي الصلاحية", near_expiry: "قريب الانتهاء", damaged: "تالف", quarantine: "حجر", dead_stock: "راكد", slow_moving: "بطيء الحركة", rate: "النسبة",
    journals: "القيود المحاسبية", generate: "توليد القيود من الحركات", period: "الفترة", debit: "مدين", credit: "دائن", account: "الحساب", costCenter: "مركز التكلفة",
    post: "ترحيل القيد", export: "تسجيل الترحيل إلى ERP", erpRef: "مرجع نظام ERP", rows: "حركات", accounts: "دليل الحسابات والربط", mapping: "ربط الحركات بالحسابات",
    frozen: "القيد المرحّل مجمّد: لا يمكن تعديل مبالغه أو بنوده",
  },
  cus: {
    custody: "العهد", mine: "عهدي", register: "سجل العهد", holder: "حامل العهدة", issued: "تاريخ الصرف", acknowledged: "الإقرار", acknowledge: "إقرار بالاستلام",
    transfer: "نقل العهدة", toUser: "إلى الموظف", returnIt: "إرجاع العهدة", lost: "إثبات فقد", active: "قائمة", return_pending: "قيد الإرجاع", returned: "مُرجعة",
    serial: "الرقم التسلسلي", notAck: "بانتظار الإقرار", clearances: "إخلاء الطرف", newClearance: "طلب إخلاء طرف", employee: "الموظف", reason: "السبب",
    resignation: "استقالة", retirement: "تقاعد", end_of_contract: "انتهاء العقد", other: "أخرى", blocked: "متوقف", cleared: "مُخلى طرفه", blockers: "الموانع",
    recheck: "إعادة الفحص", certificate: "شهادة إخلاء طرف", certNo: "رقم الشهادة", certText: "تشهد إدارة المستودعات بأن الموظف المذكور أعلاه لا توجد بذمته أي عهد أو التزامات قائمة في نظام إدارة المستودعات حتى تاريخه.",
    print: "طباعة",
  },
  kpi: { kpis: "مؤشرات الأداء", target: "المستهدف", actual: "الفعلي", trend: "الاتجاه (6 أشهر)", good: "محقق", warn: "قريب من المستهدف", bad: "غير محقق", na: "لا توجد بيانات" },
  rep: {
    reports: "التقارير", catalog: "التقارير المتاحة", schedules: "التقارير المجدولة", history: "سجل التقارير", download: "تنزيل", newSchedule: "جدولة تقرير",
    frequency: "التكرار", daily: "يومي", weekly: "أسبوعي", monthly: "شهري", hour: "الساعة (بتوقيت الرياض)", recipients: "المستلمون", nextRun: "التشغيل القادم",
    lastRun: "آخر تشغيل", runNow: "تشغيل الآن", active: "مفعّل", paused: "موقوف", toggle: "تفعيل / إيقاف", plan: "خطة الجرد", days: "عدد الأيام", lang: "اللغة",
    exportNote: "تنزيل Excel وPowerPoint يتطلب صلاحية التصدير", weekday: "اليوم", monthday: "يوم الشهر",
  },
  integ: {
    integrations: "التكامل مع الأنظمة", clients: "عملاء التكامل (مفاتيح API)", newClient: "عميل تكامل جديد", system: "النظام", scopes: "الصلاحيات",
    keyOnce: "انسخ المفتاح الآن — لن يُعرض مرة أخرى", lastUsed: "آخر استخدام", calls: "الطلبات (24 ساعة)", outbox: "صندوق الأحداث الصادرة", event: "الحدث",
    retry: "إعادة المحاولة", emails: "البريد الصادر", smtpOff: "لا يوجد خادم بريد (SMTP) — تُحفظ الرسائل في السجل دون إرسال", preview: "معاينة", callLog: "سجل الطلبات",
    stubNote: "الأحداث بحالة «stub» محفوظة لأن عنوان النظام المستقبل غير مهيأ بعد", docs: "توثيق الواجهات (OpenAPI)",
  },
  lbl: { labels: "طباعة الملصقات", bins: "ملصقات المواقع", zone: "المنطقة", all: "الكل", zpl: "تنزيل ZPL (طابعات Zebra)", printSheet: "طباعة ورقة A4" },
  portal: { portal: "بوابة الموردين", deliveries: "الشحنات والاستلام", invoices: "الفواتير والدفع", accepted: "المقبول", rejected: "المرفوض" },
  prof: { emailNotify: "استلام الإشعارات عبر البريد الإلكتروني" },
};

type D = typeof p45Ar;
export const p45En: D = {
  pl: {
    planning: "Planning & replenishment", runs: "Planning runs", newRun: "Run planning now", run: "Run", lines: "Lines", reorderValue: "Reorder value",
    action: "Recommendation", reorder: "Reorder", ok: "Within limits", excess: "Excess", dead: "Dead", no_demand: "No demand", demand: "Daily demand",
    forecast: "30-day forecast", ss: "Safety stock", rop: "Reorder point", eoq: "EOQ", minmax: "Min / max", current: "Current",
    proposed: "Proposed", free: "Free", onOrder: "On order", suggested: "Suggested qty", lt: "Lead time", apply: "Apply parameters to item policies",
    createPrs: "Create requisitions", selected: "Selected", deadStock: "Dead & slow-moving stock", idleDays: "Days without issue", slow: "Slow-moving",
    formula: "Safety stock = z × σ × √LT · ROP = daily demand × LT + safety stock · EOQ = √(2DS/Hc)",
    prs: "Purchase requisitions", pr: "Requisition", newPr: "Manual requisition", source: "Source", auto: "Auto", manual: "Manual", convert: "Convert to PO",
    estCost: "Est. cost", po: "Purchase order", cancel: "Cancel", etimadRef: "Etimad award reference", expected: "Expected date", unitPrice: "Unit price",
  },
  val: {
    valuation: "Valuation & journals", summary: "Valuation summary", method: "Book valuation method", wavg: "Weighted average", fifo: "FIFO (comparison)", ledger: "Ledger",
    gl: "General ledger", unjournalised: "Not yet journalised", reconciled: "Reconciled", notReconciled: "Difference", provision: "Obsolescence provision", items: "Item valuation",
    provisions: "Provisions", runProvision: "Compute provision", required: "Required", previous: "Previous balance", delta: "Journal delta", category: "Category",
    expired: "Expired", near_expiry: "Near expiry", damaged: "Damaged", quarantine: "Quarantine", dead_stock: "Dead stock", slow_moving: "Slow-moving", rate: "Rate",
    journals: "Journals", generate: "Generate journals from movements", period: "Period", debit: "Debit", credit: "Credit", account: "Account", costCenter: "Cost center",
    post: "Post journal", export: "Record transfer to ERP", erpRef: "ERP reference", rows: "movements", accounts: "Chart of accounts & mapping", mapping: "Movement → account mapping",
    frozen: "A posted journal is frozen: amounts and lines can no longer change",
  },
  cus: {
    custody: "Custody", mine: "My custody", register: "Custody register", holder: "Holder", issued: "Issued", acknowledged: "Acknowledged", acknowledge: "Acknowledge receipt",
    transfer: "Transfer custody", toUser: "To employee", returnIt: "Return custody", lost: "Declare lost", active: "Active", return_pending: "Return pending", returned: "Returned",
    serial: "Serial no.", notAck: "Awaiting acknowledgement", clearances: "Employee clearance", newClearance: "Request clearance", employee: "Employee", reason: "Reason",
    resignation: "Resignation", retirement: "Retirement", end_of_contract: "End of contract", other: "Other", blocked: "Blocked", cleared: "Cleared", blockers: "Blockers",
    recheck: "Re-check", certificate: "Clearance certificate", certNo: "Certificate no.", certText: "The Warehouse Department certifies that the employee named above holds no custody or open obligations in the Warehouse Management System as of this date.",
    print: "Print",
  },
  kpi: { kpis: "KPIs", target: "Target", actual: "Actual", trend: "Trend (6 months)", good: "On target", warn: "Near target", bad: "Off target", na: "No data" },
  rep: {
    reports: "Reports", catalog: "Available reports", schedules: "Scheduled reports", history: "Report history", download: "Download", newSchedule: "Schedule a report",
    frequency: "Frequency", daily: "Daily", weekly: "Weekly", monthly: "Monthly", hour: "Hour (Riyadh time)", recipients: "Recipients", nextRun: "Next run",
    lastRun: "Last run", runNow: "Run now", active: "Active", paused: "Paused", toggle: "Pause / resume", plan: "Count plan", days: "Days", lang: "Language",
    exportNote: "Excel and PowerPoint downloads need the export permission", weekday: "Weekday", monthday: "Day of month",
  },
  integ: {
    integrations: "System integrations", clients: "Integration clients (API keys)", newClient: "New integration client", system: "System", scopes: "Scopes",
    keyOnce: "Copy the key now — it will not be shown again", lastUsed: "Last used", calls: "Calls (24 h)", outbox: "Outbound events", event: "Event",
    retry: "Retry", emails: "Outgoing e-mail", smtpOff: "No SMTP server configured — messages are logged, not sent", preview: "Preview", callLog: "Call log",
    stubNote: "Events in “stub” status are kept because the receiving system's endpoint is not configured yet", docs: "API documentation (OpenAPI)",
  },
  lbl: { labels: "Print labels", bins: "Bin labels", zone: "Zone", all: "All", zpl: "Download ZPL (Zebra printers)", printSheet: "Print A4 sheet" },
  portal: { portal: "Supplier portal", deliveries: "Deliveries & receiving", invoices: "Invoices & payment", accepted: "Accepted", rejected: "Rejected" },
  prof: { emailNotify: "Receive notifications by e-mail" },
};

export const p45EventsAr: Record<string, string> = { converted: "تحويل إلى أمر شراء", issued: "صرف العهدة", acknowledged: "إقرار بالاستلام", transferred: "نقل العهدة",
  return_requested: "طلب إرجاع", lost: "إثبات فقد", checked: "فحص الموانع", cleared: "إخلاء الطرف", exported: "ترحيل إلى ERP" };
export const p45EventsEn: Record<string, string> = { converted: "Converted to PO", issued: "Custody issued", acknowledged: "Acknowledged", transferred: "Custody transferred",
  return_requested: "Return requested", lost: "Declared lost", checked: "Blockers checked", cleared: "Cleared", exported: "Transferred to ERP" };
