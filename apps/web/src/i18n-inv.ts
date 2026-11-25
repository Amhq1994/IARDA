// Phase 3 (inventory control) translations: transfers, returns, quarantine, RTV, counting, adjustments, disposals.
export const invAr = {
  inv: {
    approvals: "صندوق الاعتمادات", approvalsLead: "جميع المستندات المحالة إليك للاعتماد (طلبات المواد، النقل، فروقات الجرد والاستلام، الإتلاف، الإرجاع للمورد، طلبات الشراء)",
    transfers: "التحويلات", newTransfer: "طلب نقل بين المستودعات", fromWh: "من مستودع", toWh: "إلى مستودع", reason: "السبب", ship: "شحن (خروج من المصدر)",
    receive: "استلام في الوجهة", shipped: "المشحون", receivedQty: "المستلم", inTransit: "في الطريق", transit: "الكميات في الطريق", discrepancy: "فرق استلام",
    shipments: "الشحنات", moves: "نقل بين المواقع", moveStock: "نقل مخزون بين خانتين", fromBin: "من الخانة", toBin: "إلى الخانة",
    returns: "الرجيع", newReturn: "رجيع مواد للمستودع", condition: "الحالة", good: "سليم", quarantine: "حجر", damaged: "تالف", inspectReturn: "فحص وتسجيل الرجيع",
    rtv: "إرجاع للمورد", newRtv: "إرجاع للمورد", creditNote: "إشعار دائن", creditNoteRef: "رقم الإشعار الدائن", quarantineStock: "مخزون الحجر والتالف",
    release: "إفراج إلى المتاح", toDamaged: "نقل إلى التالف", expired: "منتهي الصلاحية", returnType: "النوع", toWarehouse: "رجيع للمستودع", toVendor: "إرجاع للمورد",
    counting: "الجرد", counts: "خطط الجرد", newCount: "خطة جرد جديدة", countType: "نوع الجرد", annual: "سنوي", cycle: "دوري (ABC)", surprise: "مفاجئ",
    blind: "جرد أعمى (دون إظهار الرصيد الدفتري)", abc: "فئات ABC", counters: "القائمون بالجرد", sampleSize: "حجم العينة", scheduledFor: "موعد الجرد",
    releaseCount: "إطلاق الجرد", finishCount: "إنهاء الجرد ومراجعة الفروقات", snapshot: "الرصيد الدفتري", count1: "العد الأول", count2: "إعادة العد",
    final: "النهائي", variance: "الفرق", varianceValue: "قيمة الفرق", tolerance: "ضمن التسامح", recount: "إعادة عد", counted: "تم العد", open: "لم يُعد",
    progress: "التقدم", blindHidden: "جرد أعمى: لا تظهر الأرصدة الدفترية للقائمين بالعد", countOnPhone: "العد من الجوال", varianceReport: "تقرير الفروقات",
    classify: "إعادة تصنيف ABC", unplanned: "صنف غير مدرج في القائمة", accuracy: "دقة المخزون",
    adjustments: "اعتماد الفروقات", newAdjustment: "اعتماد الفروقات", source: "المصدر", delta: "الفرق (+/-)", post: "ترحيل", valueAbs: "القيمة المطلقة", valueNet: "صافي الأثر",
    srcCount: "جرد", srcManual: "يدوي", srcTransit: "فرق نقل", srcQuarantine: "حجر",
    disposals: "الإتلاف والشطب", newDisposal: "محضر إتلاف / شطب", method: "طريقة التصرف", scrap: "إتلاف", sell: "بيع", donate: "تبرع", recycle: "إعادة تدوير",
    committee: "أعضاء لجنة الجرد والإتلاف", minutes: "محضر اللجنة (PDF)", uploadMinutes: "رفع المحضر", recommend: "توصية اللجنة وإحالة للاعتماد",
    totalValue: "القيمة الإجمالية", sodNote: "فصل المهام: اللجنة توصي فقط؛ يعتمد مدير المستودع والمالية؛ يرحّل أمين مستودع من خارج اللجنة",
    docType: "المستند", selectStock: "اختر من الأرصدة", none: "لا يوجد",
  },
  docType: { MR: "طلب مواد", TR: "طلب نقل", ADJ: "فروقات مخزون", DSP: "إتلاف", RTV: "إرجاع للمورد", RET: "رجيع", CNT: "جرد" },
  docStatus: { draft: "مسودة", pending_approval: "بانتظار الاعتماد", approved: "معتمد", rejected: "مرفوض", in_transit: "في الطريق", received: "مستلم — فرق قيد الاعتماد",
    closed: "مغلق", cancelled: "ملغى", shipped: "مشحون للمورد", posted: "مُرحّل", counting: "قيد العد", review: "مراجعة الفروقات",
    converted: "حُوّل إلى أمر شراء", exported: "مُرحّل إلى ERP", active: "قائمة", return_pending: "قيد الإرجاع", returned: "مُرجعة", lost: "مفقودة",
    blocked: "متوقف (توجد موانع)", cleared: "مُخلى طرفه", reorder: "إعادة طلب", excess: "فائض", dead: "راكد", no_demand: "لا طلب", ok: "ضمن الحدود",
    good: "محقق", warn: "قريب", bad: "غير محقق", na: "لا بيانات", pending: "قيد الإرسال", delivered: "مُسلّم", stub: "محفوظ (لا يوجد مستقبل)", failed: "فشل",
    logged: "محفوظ بالسجل", sent: "مُرسل", open: "مفتوح", partially_received: "مستلم جزئياً" },
  stockStatus: { available: "متاح", quarantine: "حجر", damaged: "تالف", in_transit: "في الطريق", inspection: "تحت الفحص" },
};

type D = typeof invAr;
export const invEn: D = {
  inv: {
    approvals: "Approvals inbox", approvalsLead: "Every document routed to you (material requests, transfers, count & receipt variances, disposals, returns to vendor, requisitions)",
    transfers: "Transfers", newTransfer: "Inter-warehouse transfer", fromWh: "From warehouse", toWh: "To warehouse", reason: "Reason", ship: "Ship (leave source)",
    receive: "Receive at destination", shipped: "Shipped", receivedQty: "Received", inTransit: "In transit", transit: "In-transit quantities", discrepancy: "Receipt discrepancy",
    shipments: "Shipments", moves: "Bin moves", moveStock: "Move stock between bins", fromBin: "From bin", toBin: "To bin",
    returns: "Returns", newReturn: "Return to warehouse", condition: "Condition", good: "Good", quarantine: "Quarantine", damaged: "Damaged", inspectReturn: "Inspect & book return",
    rtv: "Return to vendor", newRtv: "Return to vendor", creditNote: "Credit note", creditNoteRef: "Credit note no.", quarantineStock: "Quarantine & damaged stock",
    release: "Release to available", toDamaged: "Move to damaged", expired: "Expired", returnType: "Type", toWarehouse: "Return to warehouse", toVendor: "Return to vendor",
    counting: "Counting", counts: "Count plans", newCount: "New count plan", countType: "Count type", annual: "Annual", cycle: "Cycle (ABC)", surprise: "Surprise",
    blind: "Blind count (book quantity hidden)", abc: "ABC classes", counters: "Counters", sampleSize: "Sample size", scheduledFor: "Scheduled for",
    releaseCount: "Release count", finishCount: "Finish & review variances", snapshot: "Book qty", count1: "1st count", count2: "Recount",
    final: "Final", variance: "Variance", varianceValue: "Variance value", tolerance: "Within tolerance", recount: "Recount", counted: "Counted", open: "Not counted",
    progress: "Progress", blindHidden: "Blind count: book quantities are hidden from counters", countOnPhone: "Count on phone", varianceReport: "Variance report",
    classify: "Recompute ABC", unplanned: "Item not on the sheet", accuracy: "Inventory accuracy",
    adjustments: "Variance approval", newAdjustment: "Variance approval", source: "Source", delta: "Delta (+/-)", post: "Post", valueAbs: "Absolute value", valueNet: "Net impact",
    srcCount: "Count", srcManual: "Manual", srcTransit: "Transit shortfall", srcQuarantine: "Quarantine",
    disposals: "Write-offs & disposal", newDisposal: "Disposal / write-off minutes", method: "Method", scrap: "Scrap", sell: "Sell", donate: "Donate", recycle: "Recycle",
    committee: "Count & disposal committee", minutes: "Committee minutes (PDF)", uploadMinutes: "Upload minutes", recommend: "Committee recommendation → approval",
    totalValue: "Total value", sodNote: "SoD: the committee only recommends; the warehouse manager and finance approve; a storekeeper outside the committee posts",
    docType: "Document", selectStock: "Pick from stock", none: "None",
  },
  docType: { MR: "Material request", TR: "Transfer", ADJ: "Adjustment", DSP: "Disposal", RTV: "Return to vendor", RET: "Return", CNT: "Count" },
  docStatus: { draft: "Draft", pending_approval: "Pending approval", approved: "Approved", rejected: "Rejected", in_transit: "In transit", received: "Received — discrepancy pending",
    closed: "Closed", cancelled: "Cancelled", shipped: "Shipped to vendor", posted: "Posted", counting: "Counting", review: "Variance review",
    converted: "Converted to PO", exported: "Transferred to ERP", active: "Active", return_pending: "Return pending", returned: "Returned", lost: "Lost",
    blocked: "Blocked", cleared: "Cleared", reorder: "Reorder", excess: "Excess", dead: "Dead", no_demand: "No demand", ok: "Within limits",
    good: "On target", warn: "Near", bad: "Off target", na: "No data", pending: "Pending", delivered: "Delivered", stub: "Kept (no endpoint)", failed: "Failed",
    logged: "Logged", sent: "Sent", open: "Open", partially_received: "Partially received" },
  stockStatus: { available: "Available", quarantine: "Quarantine", damaged: "Damaged", in_transit: "In transit", inspection: "Under inspection" },
};

export const invEventsAr: Record<string, string> = {
  shipped: "شحن", received: "استلام", received_with_discrepancy: "استلام مع فرق", released: "إطلاق الجرد", count_completed: "اكتمال العد", posted: "ترحيل",
  credit_note: "استلام إشعار دائن", approved_l1: "اعتماد المستوى 1", approved_l2: "اعتماد المستوى 2", approved_l3: "اعتماد المستوى 3", rejected_l3: "رفض", returned_l3: "إعادة للتعديل",
};
export const invEventsEn: Record<string, string> = {
  shipped: "Shipped", received: "Received", received_with_discrepancy: "Received with discrepancy", released: "Count released", count_completed: "Count completed", posted: "Posted",
  credit_note: "Credit note received", approved_l1: "Level 1 approved", approved_l2: "Level 2 approved", approved_l3: "Level 3 approved", rejected_l3: "Rejected", returned_l3: "Returned for revision",
};
