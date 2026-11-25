// Demo seed (Arabic): org units, 14 roles + permission matrix, 28 users (every role), 8 suppliers,
// 5 warehouses (spare parts, cleaning, hospitality, scrap, assets) with Zone>Aisle>Rack>Bin structure, 8 categories / 200 items,
// settings. Run on a freshly migrated database: npm run db:seed
import pg from "pg";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, ZONE_TYPES, type RoleCode } from "@iarda/shared";
import { config } from "../src/config.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { hashPassword } from "../src/auth/routes.ts";
import { CATALOG, UOMS } from "./catalog.ts";
import { seedPhase2 } from "./seed-phase2.ts";
import { seedPhase3 } from "./seed-phase3.ts";
import { seedPhase4 } from "./seed-phase4.ts";

export const DEMO_PASSWORD = "Iarda@2026!";

const ORG = [
  ["EXE", "الإدارة التنفيذية", "Executive Office", "agency", null, "CC100", 0],
  ["OPS", "الإدارة العامة للعمليات", "General Directorate of Operations", "department", "EXE", "CC200", 6_500_000],
  ["ENV", "إدارة الحماية والرقابة البيئية", "Environmental Protection & Compliance", "department", "OPS", "CC210", 3_200_000],
  ["MNT", "إدارة الصيانة والتشغيل", "Maintenance & Operations", "department", "OPS", "CC220", 4_800_000],
  ["LOG", "إدارة المستودعات والإمداد", "Warehousing & Logistics", "department", "OPS", "CC230", 2_100_000],
  ["ITD", "إدارة تقنية المعلومات", "Information Technology", "department", "EXE", "CC300", 2_900_000],
  ["FIN", "الإدارة المالية", "Finance", "department", "EXE", "CC400", 600_000],
  ["PRC", "إدارة المشتريات والعقود", "Procurement & Contracts", "department", "EXE", "CC500", 450_000],
  ["AUD", "إدارة المراجعة الداخلية", "Internal Audit", "department", "EXE", "CC600", 250_000],
] as const;

// [username, name_ar, name_en, org, position_ar, position_en, roles[], warehouses (codes) | null]
const USERS: [string, string, string, string, string, string, RoleCode[], string[] | null][] = [
  ["admin", "عبدالعزيز محمد القحطاني", "Abdulaziz M. Al-Qahtani", "ITD", "مدير النظام", "System Administrator", ["ADM"], null],
  ["wm.cons", "فهد بن عبدالله الدوسري", "Fahad A. Al-Dosari", "LOG", "مدير مستودعات المستهلكات (النظافة والضيافة)", "Consumables Warehouses Manager", ["WM"], ["CLN", "HSP"]],
  ["wm.assets", "خالد بن محمد العنزي", "Khalid M. Al-Anazi", "LOG", "مدير مستودعات الأصول وقطع الغيار والهالك", "Assets, Spare Parts & Scrap Warehouses Manager", ["WM"], ["AST", "SPR", "SCR"]],
  ["sk.cleaning", "عبدالرحمن بن سالم الشهري", "Abdulrahman S. Al-Shehri", "LOG", "أمين مستودع مستهلكات النظافة", "Storekeeper – Cleaning consumables", ["SK"], ["CLN"]],
  ["sk.hosp", "ماجد بن فيصل الرشيدي", "Majed F. Al-Rashidi", "LOG", "أمين مستودع مستهلكات الضيافة", "Storekeeper – Hospitality consumables", ["SK"], ["HSP"]],
  ["sk.spare", "تركي بن علي الحربي", "Turki A. Al-Harbi", "LOG", "أمين مستودع قطع الغيار", "Storekeeper – Spare parts", ["SK"], ["SPR"]],
  ["sk.assets", "بدر بن ناصر السبيعي", "Badr N. Al-Subaie", "LOG", "أمين مستودع الأصول والهالك", "Storekeeper – Assets & scrap", ["SK"], ["AST", "SCR"]],
  ["ww.cleaning1", "أحمد بن حسن الزهراني", "Ahmed H. Al-Zahrani", "LOG", "عامل مستودع", "Warehouse Worker", ["WW"], ["CLN"]],
  ["ww.cleaning2", "يوسف بن إبراهيم المالكي", "Yousef I. Al-Malki", "LOG", "عامل مستودع", "Warehouse Worker", ["WW"], ["CLN"]],
  ["ww.hosp", "نايف بن سعود الشمري", "Naif S. Al-Shammari", "LOG", "عامل مستودع", "Warehouse Worker", ["WW"], ["HSP"]],
  ["ww.assets", "فيصل بن عمر القرشي", "Faisal O. Al-Qurashi", "LOG", "عامل مستودع", "Warehouse Worker", ["WW"], ["AST", "SPR", "SCR"]],
  ["mdo", "نورة بنت عبدالعزيز العتيبي", "Noura A. Al-Otaibi", "LOG", "مسؤولة البيانات الرئيسية", "Master Data Officer", ["MDO"], null],
  ["planner", "ريم بنت خالد السبيعي", "Reem K. Al-Subaie", "LOG", "مخططة المخزون", "Inventory Planner", ["PLN"], null],
  ["req.env", "محمد بن صالح المطيري", "Mohammed S. Al-Mutairi", "ENV", "أخصائي رقابة بيئية", "Environmental Inspector", ["REQ"], null],
  ["req.mnt", "عمر بن عبدالله الغامدي", "Omar A. Al-Ghamdi", "MNT", "فني صيانة", "Maintenance Technician", ["REQ"], null],
  ["req.it", "سارة بنت فهد القرني", "Sara F. Al-Qarni", "ITD", "أخصائية دعم فني", "IT Support Specialist", ["REQ"], null],
  ["dm.env", "عبدالله بن راشد البقمي", "Abdullah R. Al-Buqami", "ENV", "مدير إدارة الحماية والرقابة", "Director, Environmental Protection", ["DM"], null],
  ["dm.mnt", "سلطان بن مشعل العمري", "Sultan M. Al-Omari", "MNT", "مدير إدارة الصيانة والتشغيل", "Director, Maintenance & Operations", ["DM"], null],
  ["dm.it", "هند بنت سليمان الحمدان", "Hind S. Al-Hamdan", "ITD", "مديرة إدارة تقنية المعلومات", "Director, IT", ["DM"], null],
  ["irc1", "بندر بن عايض الأسمري", "Bandar A. Al-Asmari", "MNT", "رئيس لجنة الفحص والاستلام", "Chair, Inspection & Receiving Committee", ["IRC"], null],
  ["irc2", "وليد بن حمد الدعجاني", "Waleed H. Al-Dajani", "ENV", "عضو لجنة الفحص والاستلام", "Member, Inspection Committee", ["IRC"], null],
  ["irc3", "مها بنت ناصر الشهراني", "Maha N. Al-Shahrani", "ITD", "عضو لجنة الفحص والاستلام", "Member, Inspection Committee", ["IRC"], null],
  ["cdc1", "إبراهيم بن عبدالكريم الجهني", "Ibrahim A. Al-Juhani", "FIN", "رئيس لجنة الجرد والإتلاف", "Chair, Count & Disposal Committee", ["CDC"], null],
  ["cdc2", "لمى بنت أحمد الخالدي", "Lama A. Al-Khalidi", "AUD", "عضو لجنة الجرد والإتلاف", "Member, Count & Disposal Committee", ["CDC"], null],
  ["proc", "منصور بن زيد السهلي", "Mansour Z. Al-Sahli", "PRC", "أخصائي مشتريات", "Procurement Specialist", ["PRC"], null],
  ["fin", "أمل بنت يوسف الراجحي", "Amal Y. Al-Rajhi", "FIN", "محاسبة المخزون", "Inventory Accountant", ["FIN"], null],
  ["auditor", "طلال بن مساعد العصيمي", "Talal M. Al-Osaimi", "AUD", "مراجع داخلي", "Internal Auditor", ["AUD"], null],
  ["supplier.rowad", "شركة الرواد للتجهيزات", "Al-Rowad Supplies (portal)", "PRC", "مستخدم بوابة الموردين", "Supplier portal user", ["SUP"], null],
];

const SUPPLIERS = [
  ["SUP-001", "شركة الرواد للتجهيزات", "Al-Rowad Supplies Co.", "الرياض"],
  ["SUP-002", "مؤسسة الصحراء للتجارة العامة", "Al-Sahraa General Trading Est.", "الرياض"],
  ["SUP-003", "شركة النخبة لقطع غيار المعدات والتكييف", "Elite Equipment & HVAC Parts Co.", "الدمام"],
  ["SUP-004", "شركة الأمان الأولى لمعدات السلامة", "First Safety Equipment Co.", "جدة"],
  ["SUP-005", "شركة الواحة لمواد التنظيف", "Al-Waha Cleaning Materials Co.", "الرياض"],
  ["SUP-006", "شركة الضيافة الراقية للتموين", "Premium Hospitality Supplies Co.", "الرياض"],
  ["SUP-007", "شركة المدار للحلول التقنية", "Al-Madar Technology Solutions", "الرياض"],
  ["SUP-008", "مؤسسة المحمل للأثاث والتجهيزات", "Al-Mahmal Furniture & Fit-out Est.", "الرياض"],
];

const WAREHOUSES = [
  { code: "SPR", ar: "مستودع قطع الغيار", en: "Spare Parts Warehouse", type: "spare_parts", city: "الرياض", lat: 24.6877, lng: 46.7219, rule: "FIFO", mgr: "wm.assets",
    layout: { storage: [5, 6, 4], picking: [1, 4, 4], other: [1, 1, 4] } },
  { code: "CLN", ar: "مستودع مستهلكات النظافة", en: "Cleaning Consumables Warehouse", type: "consumables", city: "الرياض", lat: 24.7136, lng: 46.6753, rule: "FEFO", mgr: "wm.cons",
    layout: { storage: [6, 5, 5], picking: [2, 4, 5], other: [1, 2, 4] } },
  { code: "HSP", ar: "مستودع مستهلكات الضيافة", en: "Hospitality Consumables Warehouse", type: "consumables", city: "الرياض", lat: 24.7141, lng: 46.6760, rule: "FEFO", mgr: "wm.cons",
    layout: { storage: [4, 5, 4], picking: [1, 3, 4], other: [1, 1, 4] } },
  { code: "SCR", ar: "مستودع الهالك", en: "Scrap & Obsolete Warehouse", type: "scrap", city: "الرياض", lat: 24.6890, lng: 46.7230, rule: "FIFO", mgr: "wm.assets",
    layout: { storage: [2, 3, 4], picking: [1, 1, 2], other: [1, 1, 3] } },
  { code: "AST", ar: "مستودع الأصول", en: "Assets Warehouse", type: "assets", city: "الرياض", lat: 24.7120, lng: 46.6740, rule: "FIFO", mgr: "wm.assets",
    layout: { storage: [5, 5, 4], picking: [1, 3, 4], other: [1, 1, 4] } },
] as const;

// which warehouses stock each category (codes)
// (the scrap warehouse holds no planned stock: damaged / obsolete items move there pending disposal)
const STOCKED_IN: Record<string, string[]> = {
  CLN: ["CLN"], HSP: ["HSP"], EQP: ["SPR"], ELC: ["SPR"], SAF: ["AST", "CLN"], CMP: ["AST"], ITE: ["AST"], FUR: ["AST"],
};

const SETTINGS: [string, unknown, string, string][] = [
  ["valuation.default_method", "WAVG", "طريقة التقييم الافتراضية", "Default valuation method"],
  ["picking.default_rule", { expiryTracked: "FEFO", other: "FIFO" }, "قاعدة الصرف الافتراضية", "Default picking rule"],
  ["requests.sla_hours", { standard: 24, urgent: 4 }, "مدة الخدمة لطلبات المواد (ساعات)", "Material request SLA (hours)"],
  ["count.tolerance_pct", { A: 0, B: 2, C: 2 }, "نسبة التسامح في الجرد حسب الفئة", "Count tolerance by ABC class (%)"],
  ["match.tolerance_pct", { qty: 2, price: 1 }, "نسبة التسامح في المطابقة الثلاثية", "3-way match tolerance (%)"],
  ["numbering.format", "{TYPE}-{HIJRI_YEAR}-{SEQ6}", "صيغة ترقيم المستندات", "Document numbering format"],
  ["dates.primary_calendar", "hijri", "التقويم الأساسي في العرض", "Primary display calendar"],
  ["security.mfa_required_roles", [], "الأدوار التي تتطلب المصادقة الثنائية", "Roles that must use MFA"],
  ["dead_stock.months", 12, "مدة عدم الحركة لاعتبار المخزون راكداً (أشهر)", "Months without movement for dead stock"],
];

/** Valid EAN-13 with the Saudi GS1 prefix 628. */
function ean13(n: number): string {
  const base = `628${String(1_000_000_000 + n).slice(1)}`.slice(0, 12);
  const sum = [...base].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return base + ((10 - (sum % 10)) % 10);
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export async function seed(databaseUrl = config.databaseUrl, log = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const q = (sql: string, p: unknown[] = []) => client.query(sql, p);
  try {
    if ((await q("SELECT count(*)::int AS n FROM role")).rows[0].n > 0) {
      log("seed: phase 1 data present — skipping");
      await client.end();
      await seedPhase2(databaseUrl, log);
      await seedPhase3(databaseUrl, log);
    await seedPhase4(databaseUrl, log);
      return;
    }
    await q("BEGIN");

    // system actor for the audit trail of seeded records
    const sys = (await q(`INSERT INTO app_user (username, name_ar, name_en, auth_provider, status) VALUES ('system', 'النظام', 'System', 'local', 'inactive') RETURNING id`)).rows[0].id;
    await q("SELECT set_config('app.user_id', $1, true), set_config('app.request_id', 'seed', true)", [sys]);

    // ---- permissions & roles
    for (const [key, v] of Object.entries(PERMISSIONS)) {
      await q("INSERT INTO permission (key, name_ar, name_en, module) VALUES ($1,$2,$3,$4)", [key, v.ar, v.en, key.split(".")[0]]);
    }
    const roleId: Record<string, string> = {};
    for (const [code, r] of Object.entries(ROLES)) {
      roleId[code] = (await q("INSERT INTO role (code, name_ar, name_en, scope) VALUES ($1,$2,$3,$4) RETURNING id", [code, r.ar, r.en, r.scope])).rows[0].id;
      for (const p of ROLE_PERMISSIONS[code as RoleCode]) await q("INSERT INTO role_permission (role_id, permission_key) VALUES ($1,$2)", [roleId[code], p]);
    }

    // ---- organisation
    const orgId: Record<string, string> = {};
    for (const [code, ar, en, type, parent, cc, budget] of ORG) {
      orgId[code] = (await q(`INSERT INTO org_unit (code, name_ar, name_en, unit_type, parent_id, cost_center_code, annual_budget)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [code, ar, en, type, parent ? orgId[parent] : null, cc, budget])).rows[0].id;
    }

    // ---- suppliers
    const supId: Record<string, string> = {};
    let s = 0;
    for (const [code, ar, en, city] of SUPPLIERS) {
      s++;
      supId[code] = (await q(`INSERT INTO supplier (code, name_ar, name_en, cr_number, vat_number, etimad_vendor_id, contact_email, contact_phone, city)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [code, ar, en, `10100${pad(s, 5)}`, `3${String(100000000000 + s * 7919).padStart(12, "0")}3`, `ET-${2400 + s}`,
         `sales${s}@supplier${s}.example.sa`, `+96611${pad(s * 1234567 % 10000000, 7)}`, city])).rows[0].id;
    }

    // ---- users
    const pw = await hashPassword(DEMO_PASSWORD);
    const userId: Record<string, string> = {};
    let e = 1000;
    for (const [username, ar, en, org, pAr, pEn] of USERS) {
      userId[username] = (await q(`INSERT INTO app_user (username, employee_no, name_ar, name_en, email, mobile_enc, org_unit_id, position_ar, position_en,
          supplier_id, password_hash, password_changed_at, preferred_lang)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), 'ar') RETURNING id`,
        [username, username.startsWith("supplier") ? null : `E${++e}`, ar, en, `${username}@iarda.example.sa`, encrypt(`+9665${pad(e * 7331 % 100000000, 8)}`),
         orgId[org], pAr, pEn, username.startsWith("supplier") ? supId["SUP-001"] : null, pw])).rows[0].id;
    }
    // managers
    for (const [u, m] of [["req.env", "dm.env"], ["req.mnt", "dm.mnt"], ["req.it", "dm.it"], ["sk.cleaning", "wm.cons"], ["sk.hosp", "wm.cons"],
      ["sk.spare", "wm.assets"], ["sk.assets", "wm.assets"], ["ww.cleaning1", "sk.cleaning"], ["ww.cleaning2", "sk.cleaning"], ["ww.hosp", "sk.hosp"], ["ww.assets", "sk.assets"]]) {
      await q("UPDATE app_user SET manager_id = $2 WHERE id = $1", [userId[u], userId[m]]);
    }

    // ---- warehouses & structure
    const whId: Record<string, string> = {};
    let binCount = 0;
    for (const w of WAREHOUSES) {
      const mgr = userId[w.mgr];
      whId[w.code] = (await q(`INSERT INTO warehouse (code, name_ar, name_en, warehouse_type, city, latitude, longitude, manager_user_id, default_picking_rule)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [w.code, w.ar, w.en, w.type, w.city, w.lat, w.lng, mgr, w.rule])).rows[0].id;
      let seq = 0;
      for (const [type, z] of Object.entries(ZONE_TYPES)) {
        const zone = (await q(`INSERT INTO location (warehouse_id, level, code, full_code, name_ar, name_en, zone_type, barcode, temperature_controlled)
          VALUES ($1,'zone',$2,$3,$4,$5,$6,$3,$7) RETURNING id, full_code`,
          [whId[w.code], z.code, `${w.code}-${z.code}`, `منطقة ${z.ar}`, `${z.en} zone`, type, w.code === "HSP" && type === "storage"])).rows[0];
        const [aisles, racks, bins] = type === "storage" ? w.layout.storage : type === "picking" ? w.layout.picking : w.layout.other;
        for (let a = 1; a <= aisles; a++) {
          const aisle = (await q(`INSERT INTO location (warehouse_id, parent_id, level, code, full_code, barcode) VALUES ($1,$2,'aisle',$3,$4,$4) RETURNING id, full_code`,
            [whId[w.code], zone.id, `A${pad(a)}`, `${zone.full_code}-A${pad(a)}`])).rows[0];
          for (let r = 1; r <= racks; r++) {
            const rack = (await q(`INSERT INTO location (warehouse_id, parent_id, level, code, full_code, barcode) VALUES ($1,$2,'rack',$3,$4,$4) RETURNING id, full_code`,
              [whId[w.code], aisle.id, `R${pad(r)}`, `${aisle.full_code}-R${pad(r)}`])).rows[0];
            for (let b = 1; b <= bins; b++) {
              const velocity = type === "picking" ? "fast" : a <= 2 ? "fast" : a <= Math.ceil(aisles * 0.6) ? "medium" : "slow";
              const heavy = b === 1; // ground level bins carry more weight
              await q(`INSERT INTO location (warehouse_id, parent_id, level, code, full_code, barcode, max_weight_kg, max_volume_m3, velocity_class, pick_sequence, hazmat_allowed)
                VALUES ($1,$2,'bin',$3,$4,$4,$5,$6,$7,$8,$9)`,
                [whId[w.code], rack.id, `B${pad(b)}`, `${rack.full_code}-B${pad(b)}`, heavy ? 1500 : 600, heavy ? 2.4 : 1.2, velocity, ++seq,
                 ["SPR", "CLN"].includes(w.code) && type === "storage" && a === aisles]);
              binCount++;
            }
          }
        }
      }
    }
    // a couple of blocked bins for realism
    await q(`UPDATE location SET is_blocked = true, block_reason = 'صيانة الرفوف' WHERE full_code IN ('CLN-STR-A06-R05-B05','HSP-STR-A04-R05-B04')`);

    // ---- units of measure
    const uomId: Record<string, string> = {};
    for (const [code, ar, en, dim] of UOMS) {
      uomId[code] = (await q("INSERT INTO uom (code, name_ar, name_en, dimension) VALUES ($1,$2,$3,$4) RETURNING id", [code, ar, en, dim])).rows[0].id;
    }

    // ---- categories, groups, items
    const users = { mdo: userId.mdo, wm: userId["wm.cons"], reqEnv: userId["req.env"], reqMnt: userId["req.mnt"], planner: userId.planner };
    let n = 0;
    const allItems: { id: string; cat: string; group: string; type: string; ved: string; cost: number; uom: string }[] = [];
    for (const cat of CATALOG) {
      const catId = (await q(`INSERT INTO item_category (code, name_ar, name_en, level, gl_inventory_account, gl_expense_account, valuation_method, is_critical)
        VALUES ($1,$2,$3,'category',$4,$5,'WAVG',$6) RETURNING id`, [cat.code, cat.ar, cat.en, cat.gl, `5${cat.gl.slice(1)}`, !!cat.critical])).rows[0].id;
      for (const g of cat.groups) {
        const gId = (await q(`INSERT INTO item_category (code, name_ar, name_en, level, parent_id) VALUES ($1,$2,$3,'group',$4) RETURNING id`,
          [g.code, g.ar, g.en, catId])).rows[0].id;
        let seq = 0;
        for (const [ar, en, uom, type, flags, ved, kg, m3, cost] of g.items) {
          n++; seq++;
          const code = `${g.code}-${pad(seq, 5)}`;
          const batch = flags.includes("B"), serial = flags.includes("S"), expiry = flags.includes("E") && (batch || serial);
          const shelf = expiry ? (cat.code === "HSP" ? 365 : cat.code === "CLN" ? 720 : 730) : null;
          const specs: Record<string, string> = {};
          if (cat.code === "EQP") specs["التوافق / Fitment"] = /generator|مولد/i.test(en) ? "Perkins / Cummins 20–100 kVA" : "General";
          if (cat.code === "ITE") specs["الضمان / Warranty"] = "36 months";
          if (cat.code === "HSP" && /milk|juice|laban/i.test(en)) specs["التخزين / Storage"] = "Cool & dry, below 25 °C";
          // lifecycle mix for demo: a few requests/drafts/pending items, one blocked
          const status = n % 47 === 0 ? "pending_approval" : n % 61 === 0 ? "draft" : n === 199 ? "requested" : n === 123 ? "blocked" : "active";
          const requester = status === "requested" ? users.reqEnv : status === "pending_approval" && n % 2 ? users.reqMnt : users.mdo;
          const row = (await q(`INSERT INTO item (item_code, name_ar, name_en, description_ar, specs, group_id, item_type, base_uom_id, track_batch, track_serial,
              track_expiry, shelf_life_days, unit_weight_kg, unit_volume_m3, storage_conditions, ved_class, standard_cost, status, status_reason,
              requested_by, created_by, submitted_by, approved_by, approved_at, hazard_class)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
            [code, ar, en, null, JSON.stringify(specs), gId, type, uomId[uom], batch, serial, expiry, shelf, kg, m3,
             cat.code === "HSP" ? "مكان جاف وبارد بعيداً عن أشعة الشمس" : cat.code === "CLN" ? "بعيداً عن المواد الغذائية" : null,
             ved, cost, status, status === "blocked" ? "بانتظار تحديث المواصفة الفنية" : null,
             requester, users.mdo, status === "pending_approval" ? users.mdo : null,
             status === "active" || status === "blocked" ? users.wm : null, status === "active" || status === "blocked" ? new Date(Date.now() - 86400000 * 300) : null,
             /Concentrated|bleach|Chlorine|Limescale|refrigerant/i.test(en) ? "Irritant / corrosive — store separately" : null])).rows[0].id;
          await q("INSERT INTO item_code_sequence (group_id, next_no) VALUES ($1, $2) ON CONFLICT (group_id) DO UPDATE SET next_no = $2", [gId, seq + 1]);
          // identifiers
          if (status !== "requested") {
            await q("INSERT INTO item_identifier (item_id, id_type, value, is_primary) VALUES ($1,'barcode',$2,true)", [row, ean13(n)]);
          }
          if (flags.includes("P")) {
            await q("INSERT INTO item_identifier (item_id, id_type, value, manufacturer) VALUES ($1,'mpn',$2,$3)", [row, `MPN-${g.code}-${1000 + seq * 37}`, "OEM"]);
          }
          if (type === "asset" || serial) {
            await q("INSERT INTO item_identifier (item_id, id_type, value) VALUES ($1,'qr',$2)", [row, `IARDA:ITEM:${code}`]);
          }
          // UoM conversions
          if (flags.includes("C") || ["BOX", "PKT", "REAM"].includes(uom)) {
            const factor = uom === "REAM" ? 5 : uom === "L" ? 4 : uom === "ROLL" ? 12 : uom === "PAIR" ? 12 : uom === "EA" ? 24 : 10;
            await q("INSERT INTO item_uom_conversion (item_id, uom_id, factor_to_base, is_purchase_default) VALUES ($1,$2,$3,true)", [row, uomId.CTN, factor]);
          }
          allItems.push({ id: row, cat: cat.code, group: g.code, type, ved, cost, uom });
        }
      }
    }
    // substitutes (realistic pairs)
    const byName = async (ar: string) => (await q("SELECT id FROM item WHERE name_ar = $1", [ar])).rows[0]?.id;
    for (const [a, b] of [["شاي أسود أكياس (100 كيس)", "شاي أخضر أكياس (100 كيس)"], ["سكر أبيض أعواد (علبة 100)", "سكر بني أعواد (علبة 100)"],
      ["أكواب ورقية 8 أونص (1000)", "أكواب ورقية للقهوة العربية (1000)"], ["سائل تنظيف أرضيات معطر", "معقم أسطح 70% كحول"],
      ["طفاية حريق بودرة 6 كجم", "طفاية حريق ثاني أكسيد الكربون 5 كجم"], ["فلتر زيت مولد ديزل", "فلتر ديزل مولد"]]) {
      const [x, y] = [await byName(a), await byName(b)];
      if (x && y) await q("INSERT INTO item_substitute (item_id, substitute_item_id, priority, notes) VALUES ($1,$2,1,'بديل معتمد')", [x, y]);
    }

    // ---- stock policies (min / max / ROP / safety stock) per stocking warehouse
    for (const it of allItems) {
      if (it.type === "non_stock") continue;
      const whs = STOCKED_IN[it.cat] ?? ["CLN"];
      for (const code of whs) {
        const scale = it.cost > 1000 ? 1 : it.cost > 200 ? 4 : it.cost > 40 ? 15 : 40;
        const safety = Math.max(1, Math.round(scale * (it.ved === "V" ? 0.6 : 0.3)));
        const min = safety + Math.round(scale * 0.4);
        const rop = Math.max(min, safety + Math.round(scale * 0.7));
        const max = rop + scale * 2;
        await q(`INSERT INTO item_warehouse_policy (item_id, warehouse_id, min_qty, max_qty, reorder_point, safety_stock, reorder_qty, lead_time_days, picking_rule)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [it.id, whId[code], min, max, rop, safety, max - rop, it.cat === "EQP" ? 21 : it.cat === "ITE" ? 30 : 10,
           ["HSP", "CLN"].includes(it.cat) ? "FEFO" : null]);
      }
    }

    // ---- role assignments (with scopes)
    for (const [username, , , , , , roles, whs] of USERS) {
      for (const code of roles) {
        await q(`INSERT INTO user_role (user_id, role_id, warehouse_ids, org_unit_ids) VALUES ($1,$2,$3,$4)`,
          [userId[username], roleId[code], whs ? whs.map((w) => whId[w]) : null, null]);
      }
    }

    for (const [key, value, ar, en] of SETTINGS) {
      await q("INSERT INTO setting (key, value, description_ar, description_en) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING", [key, JSON.stringify(value), ar, en]);
    }

    await q("COMMIT");
    log(`seed: ${USERS.length} users, ${WAREHOUSES.length} warehouses, ${binCount} bins, ${n} items — demo password: ${DEMO_PASSWORD}`);
    await client.end();
    await seedPhase2(databaseUrl, log);
    await seedPhase3(databaseUrl, log);
    await seedPhase4(databaseUrl, log);
    return;
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().catch((e) => { console.error(e); process.exit(1); });
}
