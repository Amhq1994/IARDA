// Enumerations shared by API and web (values mirror the database CHECK constraints).

export const ITEM_TYPES = {
  stock: { ar: "مخزني", en: "Stock" },
  non_stock: { ar: "غير مخزني", en: "Non-stock" },
  consumable: { ar: "استهلاكي", en: "Consumable" },
  asset: { ar: "أصل", en: "Asset" },
} as const;
export type ItemType = keyof typeof ITEM_TYPES;

export const ITEM_STATUSES = {
  requested: { ar: "طلب إنشاء", en: "Requested" },
  draft: { ar: "مسودة", en: "Draft" },
  pending_approval: { ar: "بانتظار الاعتماد", en: "Pending approval" },
  active: { ar: "نشط", en: "Active" },
  blocked: { ar: "موقوف", en: "Blocked" },
  obsolete: { ar: "متقادم", en: "Obsolete" },
} as const;
export type ItemStatus = keyof typeof ITEM_STATUSES;

export const ABC = ["A", "B", "C"] as const;
export const XYZ = ["X", "Y", "Z"] as const;
export const VED = { V: { ar: "حيوي", en: "Vital" }, E: { ar: "ضروري", en: "Essential" }, D: { ar: "مرغوب", en: "Desirable" } } as const;

export const IDENTIFIER_TYPES = {
  barcode: { ar: "باركود", en: "Barcode" },
  qr: { ar: "رمز QR", en: "QR code" },
  rfid: { ar: "RFID", en: "RFID (EPC)" },
  mpn: { ar: "رقم قطعة المصنّع", en: "Manufacturer part no." },
} as const;
export type IdentifierType = keyof typeof IDENTIFIER_TYPES;

export const LOCATION_LEVELS = {
  zone: { ar: "منطقة", en: "Zone" },
  aisle: { ar: "ممر", en: "Aisle" },
  rack: { ar: "رف", en: "Rack" },
  bin: { ar: "خانة", en: "Bin" },
} as const;
export type LocationLevel = keyof typeof LOCATION_LEVELS;

export const ZONE_TYPES = {
  receiving: { ar: "الاستلام", en: "Receiving", code: "RCV" },
  inspection: { ar: "الفحص", en: "Inspection", code: "INS" },
  storage: { ar: "التخزين", en: "Storage", code: "STR" },
  quarantine: { ar: "الحجر", en: "Quarantine", code: "QRN" },
  picking: { ar: "التجهيز", en: "Picking", code: "PCK" },
  returns: { ar: "المرتجعات", en: "Returns", code: "RTN" },
  damaged: { ar: "التالف", en: "Damaged", code: "DMG" },
} as const;
export type ZoneType = keyof typeof ZONE_TYPES;

export const WAREHOUSE_TYPES = {
  central: { ar: "مركزي", en: "Central" },
  site: { ar: "فرعي (موقع)", en: "Site" },
  spare_parts: { ar: "قطع غيار", en: "Spare parts" },
} as const;

export const PICKING_RULES = ["FIFO", "FEFO", "LIFO"] as const;
export const VELOCITY = ["fast", "medium", "slow"] as const;
