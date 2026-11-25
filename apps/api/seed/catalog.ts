// Demo catalogue: 12 categories, 36 groups, 200 items with Arabic names.
// Item tuple: [name_ar, name_en, base_uom, type, flags, ved, kg, m3, cost(SAR)]
//   flags: B = batch, S = serial, E = expiry (with B/S), P = has manufacturer part no., C = carton conversion
export type ItemRow = [string, string, string, "stock" | "non_stock" | "consumable" | "asset", string, "V" | "E" | "D", number, number, number];

export interface GroupDef { code: string; ar: string; en: string; items: ItemRow[] }
export interface CategoryDef { code: string; ar: string; en: string; gl: string; critical?: boolean; groups: GroupDef[] }

export const UOMS: [string, string, string, string][] = [
  ["EA", "حبة", "Each", "count"], ["BOX", "علبة", "Box", "count"], ["CTN", "كرتون", "Carton", "count"], ["PKT", "باكيت", "Packet", "count"],
  ["REAM", "رزمة", "Ream", "count"], ["SET", "طقم", "Set", "count"], ["PAIR", "زوج", "Pair", "count"], ["ROLL", "لفة", "Roll", "count"],
  ["BAG", "كيس", "Bag", "count"], ["KG", "كيلوجرام", "Kilogram", "weight"], ["TON", "طن", "Tonne", "weight"], ["L", "لتر", "Litre", "volume"],
  ["DRUM", "برميل", "Drum", "count"], ["M", "متر", "Metre", "length"], ["VIAL", "قارورة", "Vial", "count"], ["DOSE", "جرعة", "Dose", "count"],
];

export const CATALOG: CategoryDef[] = [
  { code: "OFF", ar: "مستلزمات مكتبية", en: "Office supplies", gl: "140101", groups: [
    { code: "OFPAP", ar: "ورق ومطبوعات", en: "Paper & printed forms", items: [
      ["ورق تصوير A4 80 جرام", "A4 copy paper 80 gsm", "REAM", "consumable", "C", "E", 2.5, 0.003, 18],
      ["ورق تصوير A3 80 جرام", "A3 copy paper 80 gsm", "REAM", "consumable", "C", "D", 5, 0.006, 39],
      ["ظرف رسمي مقاس A4 بشعار الهيئة", "Official A4 envelope with logo", "PKT", "consumable", "C", "D", 1.2, 0.004, 45],
      ["دفتر محاضر اجتماعات", "Meeting minutes book", "EA", "consumable", "", "D", 0.5, 0.001, 22],
      ["ورق لاصق للملاحظات 76×76", "Sticky notes 76×76", "PKT", "consumable", "C", "D", 0.1, 0.0003, 7],
      ["نموذج سند صرف مواد مرقم", "Numbered material issue form", "BOX", "consumable", "", "E", 2, 0.004, 60],
    ] },
    { code: "OFWRT", ar: "أدوات كتابة", en: "Writing instruments", items: [
      ["قلم حبر جاف أزرق", "Blue ballpoint pen", "BOX", "consumable", "C", "D", 0.2, 0.0004, 12],
      ["قلم حبر جاف أسود", "Black ballpoint pen", "BOX", "consumable", "C", "D", 0.2, 0.0004, 12],
      ["قلم تحديد فسفوري", "Highlighter marker", "BOX", "consumable", "", "D", 0.15, 0.0003, 16],
      ["قلم سبورة بيضاء", "Whiteboard marker", "BOX", "consumable", "", "D", 0.2, 0.0004, 19],
      ["قلم رصاص HB", "HB pencil", "BOX", "consumable", "", "D", 0.1, 0.0002, 8],
      ["مصحح سائل", "Correction fluid", "EA", "consumable", "", "D", 0.03, 0.00005, 4],
    ] },
    { code: "OFFIL", ar: "حفظ وملفات", en: "Filing & archiving", items: [
      ["ملف علاقي بلاستيك", "Plastic lever-arch file", "EA", "consumable", "C", "D", 0.6, 0.004, 11],
      ["ملف أرشيف كرتوني", "Archive box file", "EA", "consumable", "C", "D", 0.4, 0.008, 9],
      ["فواصل ملفات ملونة", "Coloured file dividers", "PKT", "consumable", "", "D", 0.1, 0.0003, 6],
      ["ملف شفاف بجيب", "Clear pocket folder", "PKT", "consumable", "", "D", 0.3, 0.0008, 14],
      ["صندوق حفظ وثائق بلاستيكي", "Plastic document storage box", "EA", "consumable", "", "D", 1.1, 0.03, 35],
    ] },
    { code: "OFDSK", ar: "مستلزمات المكتب", en: "Desk accessories", items: [
      ["دباسة مكتبية", "Office stapler", "EA", "consumable", "", "D", 0.3, 0.0006, 25],
      ["دبابيس دباسة 24/6", "Staples 24/6", "BOX", "consumable", "C", "D", 0.1, 0.0001, 3],
      ["خرامة ورق", "Paper punch", "EA", "consumable", "", "D", 0.4, 0.0008, 28],
      ["مشابك ورق معدنية", "Metal paper clips", "BOX", "consumable", "", "D", 0.1, 0.0001, 3],
      ["آلة حاسبة مكتبية", "Desktop calculator", "EA", "consumable", "", "D", 0.2, 0.0005, 45],
      ["شريط لاصق شفاف", "Clear adhesive tape", "ROLL", "consumable", "C", "D", 0.05, 0.0001, 3],
    ] },
  ] },
  { code: "CLN", ar: "مواد النظافة", en: "Cleaning supplies", gl: "140102", groups: [
    { code: "CLCHM", ar: "منظفات ومعقمات", en: "Detergents & disinfectants", items: [
      ["سائل تنظيف أرضيات معطر", "Scented floor cleaner", "L", "consumable", "BEC", "D", 1, 0.0012, 9],
      ["معقم أسطح 70% كحول", "70% alcohol surface sanitiser", "L", "consumable", "BEC", "E", 0.9, 0.0012, 16],
      ["سائل غسيل أطباق", "Dishwashing liquid", "L", "consumable", "BEC", "D", 1, 0.0012, 7],
      ["منظف زجاج", "Glass cleaner", "L", "consumable", "BEC", "D", 1, 0.0012, 8],
      ["كلور مبيض", "Chlorine bleach", "L", "consumable", "BEC", "D", 1.1, 0.0012, 5],
      ["صابون سائل لليدين", "Liquid hand soap", "L", "consumable", "BEC", "E", 1, 0.0012, 10],
    ] },
    { code: "CLTOL", ar: "أدوات النظافة", en: "Cleaning tools", items: [
      ["ممسحة أرضيات قطنية", "Cotton floor mop", "EA", "consumable", "", "D", 0.6, 0.006, 18],
      ["مكنسة يدوية بعصا", "Broom with handle", "EA", "consumable", "", "D", 0.7, 0.01, 15],
      ["سطل عصر مزدوج", "Double mop bucket", "EA", "consumable", "", "D", 4, 0.06, 140],
      ["قفازات تنظيف مطاطية", "Rubber cleaning gloves", "PAIR", "consumable", "C", "D", 0.1, 0.0003, 4],
      ["فوط مايكروفايبر", "Microfibre cloths", "PKT", "consumable", "", "D", 0.3, 0.001, 22],
    ] },
    { code: "CLPAP", ar: "مناديل وأكياس", en: "Tissues & bags", items: [
      ["مناديل ورقية علبة 200 منديل", "Facial tissue box 200", "BOX", "consumable", "C", "D", 0.3, 0.003, 4],
      ["مناديل حمام لفة", "Toilet tissue roll", "ROLL", "consumable", "C", "E", 0.12, 0.0012, 1.5],
      ["مناشف ورقية يدوية", "Hand paper towels", "PKT", "consumable", "C", "D", 0.5, 0.003, 6],
      ["أكياس نفايات كبيرة 120 لتر", "Garbage bags 120 L", "ROLL", "consumable", "C", "E", 1, 0.002, 14],
      ["أكياس نفايات طبية حمراء", "Red medical waste bags", "ROLL", "consumable", "C", "V", 1, 0.002, 21],
    ] },
  ] },
  { code: "VEH", ar: "قطع غيار المركبات", en: "Vehicle spare parts", gl: "140103", critical: true, groups: [
    { code: "VHENG", ar: "محرك وفلاتر", en: "Engine & filters", items: [
      ["فلتر زيت محرك تويوتا لاندكروزر", "Engine oil filter – Land Cruiser", "EA", "stock", "P", "V", 0.4, 0.001, 38],
      ["فلتر هواء محرك تويوتا لاندكروزر", "Engine air filter – Land Cruiser", "EA", "stock", "P", "V", 0.8, 0.008, 95],
      ["فلتر ديزل نيسان باترول", "Diesel filter – Nissan Patrol", "EA", "stock", "P", "V", 0.5, 0.0015, 72],
      ["سير مروحة محرك", "Engine fan belt", "EA", "stock", "P", "E", 0.3, 0.001, 65],
      ["بواجي إشعال (طقم 6)", "Spark plugs (set of 6)", "SET", "stock", "P", "E", 0.4, 0.0008, 140],
      ["رديتر تبريد هايلكس", "Radiator – Hilux", "EA", "stock", "SP", "V", 7.5, 0.05, 1450],
      ["مضخة ماء محرك", "Engine water pump", "EA", "stock", "SP", "V", 2.5, 0.006, 520],
    ] },
    { code: "VHTYR", ar: "إطارات وبطاريات", en: "Tyres & batteries", items: [
      ["إطار رملي 265/70R16", "Sand tyre 265/70R16", "EA", "stock", "S", "V", 16, 0.12, 780],
      ["إطار رملي 285/75R16", "Sand tyre 285/75R16", "EA", "stock", "S", "V", 18, 0.14, 890],
      ["بطارية مركبة 100 أمبير", "Vehicle battery 100 Ah", "EA", "stock", "SE", "V", 24, 0.02, 520],
      ["بطارية مركبة 70 أمبير", "Vehicle battery 70 Ah", "EA", "stock", "SE", "E", 18, 0.015, 380],
      ["ضاغط هواء إطارات 12 فولت", "12 V tyre air compressor", "EA", "stock", "S", "E", 4, 0.01, 420],
    ] },
    { code: "VHBRK", ar: "فرامل ونظام التعليق", en: "Brakes & suspension", items: [
      ["فحمات فرامل أمامية لاندكروزر", "Front brake pads – Land Cruiser", "SET", "stock", "P", "V", 2, 0.003, 260],
      ["فحمات فرامل خلفية لاندكروزر", "Rear brake pads – Land Cruiser", "SET", "stock", "P", "V", 1.8, 0.003, 230],
      ["ممتص صدمات أمامي", "Front shock absorber", "EA", "stock", "P", "E", 3.5, 0.008, 410],
      ["هوب فرامل أمامي", "Front brake disc", "EA", "stock", "P", "E", 7, 0.006, 340],
      ["زيت فرامل DOT4", "Brake fluid DOT4", "L", "consumable", "BE", "V", 1.1, 0.0012, 35],
    ] },
    { code: "VHLGT", ar: "إضاءة وكهرباء المركبات", en: "Vehicle lighting & electrics", items: [
      ["كشاف LED سقف مركبة", "Vehicle roof LED light bar", "EA", "stock", "S", "E", 3, 0.012, 650],
      ["لمبة أمامية H4", "Headlamp bulb H4", "EA", "stock", "P", "E", 0.05, 0.0001, 25],
      ["فيوزات مركبة متنوعة", "Assorted vehicle fuses", "BOX", "stock", "", "D", 0.2, 0.0003, 30],
      ["ونش كهربائي 12000 رطل", "Electric winch 12,000 lb", "EA", "asset", "S", "E", 38, 0.06, 3800],
    ] },
  ] },
  { code: "SAF", ar: "معدات السلامة", en: "Safety equipment", gl: "140104", critical: true, groups: [
    { code: "SFPPE", ar: "معدات الوقاية الشخصية", en: "Personal protective equipment", items: [
      ["خوذة سلامة بيضاء", "White safety helmet", "EA", "consumable", "", "V", 0.4, 0.008, 28],
      ["حذاء سلامة مقاس 42", "Safety shoes size 42", "PAIR", "consumable", "", "V", 1.4, 0.008, 160],
      ["سترة عاكسة فسفورية", "High-visibility vest", "EA", "consumable", "C", "E", 0.15, 0.001, 14],
      ["نظارات حماية شفافة", "Clear safety glasses", "EA", "consumable", "", "E", 0.05, 0.0004, 12],
      ["قفازات عمل جلدية", "Leather work gloves", "PAIR", "consumable", "C", "E", 0.25, 0.0008, 18],
      ["كمامة N95", "N95 respirator mask", "BOX", "consumable", "BEC", "V", 0.4, 0.004, 55],
    ] },
    { code: "SFFIR", ar: "معدات مكافحة الحريق", en: "Fire-fighting equipment", items: [
      ["طفاية حريق بودرة 6 كجم", "Dry powder extinguisher 6 kg", "EA", "stock", "SE", "V", 10, 0.015, 145],
      ["طفاية حريق ثاني أكسيد الكربون 5 كجم", "CO2 extinguisher 5 kg", "EA", "stock", "SE", "V", 14, 0.018, 320],
      ["بطانية حريق", "Fire blanket", "EA", "stock", "", "V", 1, 0.003, 65],
      ["خرطوم إطفاء 30 متر", "Fire hose 30 m", "EA", "stock", "S", "V", 9, 0.03, 480],
      ["مضرب إخماد حرائق الأعشاب", "Wildfire beater (flapper)", "EA", "stock", "", "V", 2.2, 0.02, 120],
      ["حاوية رمل إطفاء", "Fire sand bucket", "EA", "stock", "", "E", 1.5, 0.012, 40],
    ] },
    { code: "SFFAK", ar: "الإسعافات الأولية", en: "First aid", items: [
      ["حقيبة إسعافات أولية ميدانية", "Field first-aid kit", "EA", "stock", "BE", "V", 2, 0.01, 210],
      ["شاش طبي معقم", "Sterile gauze", "PKT", "consumable", "BE", "E", 0.1, 0.0004, 6],
      ["ضمادات لاصقة", "Adhesive bandages", "BOX", "consumable", "BE", "E", 0.1, 0.0003, 9],
      ["محلول مطهر للجروح", "Antiseptic solution", "L", "consumable", "BE", "E", 1, 0.0012, 26],
      ["بطانية حرارية للطوارئ", "Emergency thermal blanket", "EA", "consumable", "", "E", 0.06, 0.0002, 8],
    ] },
  ] },
  { code: "AGR", ar: "المستلزمات الزراعية", en: "Agricultural supplies", gl: "140105", groups: [
    { code: "AGSED", ar: "بذور وشتلات", en: "Seeds & seedlings", items: [
      ["بذور طلح (أكاسيا جيرارديا)", "Talh seeds (Acacia gerrardii)", "KG", "consumable", "BE", "V", 1, 0.0015, 240],
      ["بذور سمر (أكاسيا تورتيليس)", "Samur seeds (Acacia tortilis)", "KG", "consumable", "BE", "V", 1, 0.0015, 260],
      ["بذور سدر", "Sidr seeds (Ziziphus)", "KG", "consumable", "BE", "E", 1, 0.0015, 180],
      ["بذور أرطى", "Arta seeds (Calligonum)", "KG", "consumable", "BE", "E", 1, 0.0015, 310],
      ["بذور رمث", "Rimth seeds (Haloxylon)", "KG", "consumable", "BE", "E", 1, 0.0015, 290],
      ["شتلات غاف محلية", "Native ghaf seedlings", "EA", "consumable", "B", "E", 1.5, 0.006, 18],
    ] },
    { code: "AGIRR", ar: "مستلزمات الري", en: "Irrigation", items: [
      ["أنبوب ري بالتنقيط 16 ملم", "Drip irrigation pipe 16 mm", "ROLL", "stock", "", "E", 12, 0.08, 210],
      ["نقاطات ري 4 لتر/ساعة", "Drippers 4 L/h", "BAG", "stock", "", "E", 0.5, 0.002, 35],
      ["محبس ري بلاستيك 2 بوصة", "2-inch PVC irrigation valve", "EA", "stock", "", "D", 0.4, 0.001, 22],
      ["خزان مياه بلاستيكي 2000 لتر", "Plastic water tank 2000 L", "EA", "asset", "S", "E", 45, 2.4, 1250],
      ["مضخة مياه غاطسة 1.5 حصان", "Submersible water pump 1.5 hp", "EA", "asset", "S", "V", 18, 0.03, 2100],
    ] },
    { code: "AGFRT", ar: "أسمدة ومحسنات تربة", en: "Fertilisers & soil conditioners", items: [
      ["سماد عضوي 25 كجم", "Organic fertiliser 25 kg", "BAG", "consumable", "BE", "D", 25, 0.03, 38],
      ["محسن تربة بيتموس", "Peat-moss soil conditioner", "BAG", "consumable", "BE", "D", 20, 0.07, 55],
      ["بوليمر حافظ للماء", "Water-retaining polymer", "KG", "consumable", "BE", "E", 1, 0.0015, 48],
      ["سماد NPK متوازن", "Balanced NPK fertiliser", "BAG", "consumable", "BE", "D", 25, 0.03, 85],
    ] },
  ] },
  { code: "FOD", ar: "الأعلاف", en: "Fodder & feed", gl: "140106", critical: true, groups: [
    { code: "FDFED", ar: "أعلاف الحياة الفطرية", en: "Wildlife fodder", items: [
      ["شعير علفي 40 كجم", "Feed barley 40 kg", "BAG", "consumable", "BE", "V", 40, 0.06, 62],
      ["برسيم مجفف (بالة)", "Dried alfalfa bale", "EA", "consumable", "BE", "V", 22, 0.15, 45],
      ["أعلاف مكعبات للمها 25 كجم", "Oryx pellet feed 25 kg", "BAG", "consumable", "BE", "V", 25, 0.04, 70],
      ["أعلاف مكعبات للغزلان 25 كجم", "Gazelle pellet feed 25 kg", "BAG", "consumable", "BE", "V", 25, 0.04, 72],
      ["تبن قمح (بالة)", "Wheat straw bale", "EA", "consumable", "BE", "E", 18, 0.15, 28],
    ] },
    { code: "FDSUP", ar: "مكملات ومياه", en: "Supplements & water", items: [
      ["قوالب ملح معدني للحيوانات", "Mineral salt licks", "EA", "consumable", "BE", "E", 5, 0.004, 22],
      ["مكمل فيتامينات بيطري", "Veterinary vitamin supplement", "KG", "consumable", "BE", "E", 1, 0.0015, 95],
      ["مشرب مياه للحيوانات البرية", "Wildlife water trough", "EA", "asset", "S", "E", 30, 0.5, 950],
      ["معلف معدني متنقل", "Mobile steel feeder", "EA", "asset", "S", "E", 40, 0.6, 1100],
    ] },
  ] },
  { code: "CMP", ar: "معدات التخييم والجوالة", en: "Camping & ranger equipment", gl: "140107", groups: [
    { code: "CPTNT", ar: "خيام ومظلات", en: "Tents & shades", items: [
      ["خيمة ميدانية 4×4 متر", "Field tent 4×4 m", "EA", "asset", "S", "E", 55, 0.25, 2400],
      ["خيمة جوالة شخصين", "Two-person ranger tent", "EA", "stock", "", "E", 4, 0.02, 380],
      ["مظلة شبكية 6×4 متر", "Shade net canopy 6×4 m", "EA", "stock", "", "D", 12, 0.05, 520],
      ["أوتاد خيام حديد", "Steel tent pegs", "SET", "consumable", "", "D", 3, 0.004, 45],
      ["سرير ميداني قابل للطي", "Folding field cot", "EA", "stock", "", "D", 7, 0.03, 260],
    ] },
    { code: "CPRNG", ar: "معدات الحراسة والرصد", en: "Patrol & monitoring equipment", items: [
      ["منظار ميداني 10×42", "Field binoculars 10×42", "EA", "asset", "S", "V", 0.8, 0.002, 1250],
      ["جهاز لاسلكي محمول VHF", "Handheld VHF radio", "EA", "asset", "S", "V", 0.4, 0.001, 1850],
      ["كاميرا رصد الحياة الفطرية", "Wildlife trail camera", "EA", "asset", "S", "V", 0.6, 0.002, 1450],
      ["جهاز تحديد مواقع GPS محمول", "Handheld GPS unit", "EA", "asset", "S", "V", 0.3, 0.001, 1650],
      ["كشاف يدوي LED قابل للشحن", "Rechargeable LED torch", "EA", "stock", "", "E", 0.4, 0.001, 140],
      ["طائرة درون للرصد", "Monitoring drone", "EA", "asset", "S", "V", 1.5, 0.01, 9800],
    ] },
    { code: "CPFLD", ar: "معدات ميدانية", en: "Field gear", items: [
      ["حقيبة ظهر ميدانية 45 لتر", "Field backpack 45 L", "EA", "stock", "", "D", 1.6, 0.02, 290],
      ["قربة مياه 3 لتر", "Hydration bladder 3 L", "EA", "consumable", "", "E", 0.3, 0.003, 85],
      ["مولد كهربائي متنقل 3 كيلووات", "Portable generator 3 kW", "EA", "asset", "S", "V", 42, 0.12, 3900],
      ["لوح شمسي متنقل 200 واط", "Portable solar panel 200 W", "EA", "asset", "S", "E", 9, 0.04, 1350],
      ["صندوق تبريد 50 لتر", "Cool box 50 L", "EA", "stock", "", "D", 6, 0.08, 330],
    ] },
  ] },
  { code: "ITE", ar: "الأجهزة التقنية", en: "IT equipment", gl: "140108", groups: [
    { code: "ITCMP", ar: "حواسيب وملحقات", en: "Computers & peripherals", items: [
      ["حاسب محمول 14 بوصة", "14-inch laptop", "EA", "asset", "S", "E", 1.6, 0.006, 4800],
      ["حاسب مكتبي متكامل", "All-in-one desktop", "EA", "asset", "S", "E", 7, 0.05, 5200],
      ["شاشة 24 بوصة", "24-inch monitor", "EA", "asset", "S", "D", 4.5, 0.04, 780],
      ["لوحة مفاتيح عربي/إنجليزي", "Arabic/English keyboard", "EA", "consumable", "", "D", 0.6, 0.003, 65],
      ["فأرة لاسلكية", "Wireless mouse", "EA", "consumable", "", "D", 0.1, 0.0005, 45],
      ["جهاز لوحي ميداني مقاوم للصدمات", "Rugged field tablet", "EA", "asset", "S", "V", 1.1, 0.003, 4300],
    ] },
    { code: "ITNET", ar: "شبكات واتصالات", en: "Networking & communication", items: [
      ["محول شبكة 24 منفذ", "24-port network switch", "EA", "asset", "S", "E", 3, 0.008, 2100],
      ["كابل شبكة Cat6 (305 متر)", "Cat6 network cable (305 m)", "ROLL", "stock", "", "D", 10, 0.03, 520],
      ["نقطة وصول لاسلكية", "Wireless access point", "EA", "asset", "S", "E", 0.6, 0.002, 950],
      ["هاتف ثريا فضائي", "Satellite phone", "EA", "asset", "S", "V", 0.4, 0.001, 3600],
      ["قارئ باركود لاسلكي", "Wireless barcode scanner", "EA", "asset", "S", "E", 0.3, 0.001, 690],
    ] },
    { code: "ITPRN", ar: "طابعات وأحبار", en: "Printers & toner", items: [
      ["طابعة ليزر أبيض وأسود", "Mono laser printer", "EA", "asset", "S", "D", 9, 0.06, 1350],
      ["حبر طابعة ليزر أسود", "Black laser toner cartridge", "EA", "consumable", "P", "E", 0.9, 0.003, 310],
      ["طابعة ملصقات باركود حرارية", "Thermal barcode label printer", "EA", "asset", "S", "E", 2.5, 0.01, 1900],
      ["ملصقات باركود حرارية 100×50", "Thermal barcode labels 100×50", "ROLL", "consumable", "C", "E", 0.4, 0.001, 28],
      ["شريط حبر حراري", "Thermal transfer ribbon", "ROLL", "consumable", "", "E", 0.2, 0.0005, 35],
    ] },
  ] },
  { code: "FUL", ar: "الوقود والزيوت", en: "Fuel & lubricants", gl: "140109", critical: true, groups: [
    { code: "FLFUL", ar: "وقود", en: "Fuel", items: [
      ["ديزل (برميل 200 لتر)", "Diesel (200 L drum)", "DRUM", "consumable", "", "V", 175, 0.22, 140],
      ["بنزين 91 (جالون 20 لتر)", "Gasoline 91 (20 L jerry can)", "EA", "consumable", "", "V", 15, 0.025, 46],
      ["جالون وقود معدني 20 لتر", "Steel jerry can 20 L", "EA", "stock", "", "E", 4, 0.025, 95],
    ] },
    { code: "FLOIL", ar: "زيوت وشحوم", en: "Oils & greases", items: [
      ["زيت محرك ديزل 15W40", "Diesel engine oil 15W40", "L", "consumable", "BEC", "V", 0.9, 0.0012, 19],
      ["زيت محرك بنزين 5W30", "Gasoline engine oil 5W30", "L", "consumable", "BEC", "V", 0.9, 0.0012, 24],
      ["زيت ناقل حركة أوتوماتيك", "Automatic transmission fluid", "L", "consumable", "BE", "E", 0.9, 0.0012, 28],
      ["شحم متعدد الاستخدامات", "Multipurpose grease", "KG", "consumable", "BE", "E", 1, 0.0012, 22],
      ["سائل تبريد محرك", "Engine coolant", "L", "consumable", "BE", "E", 1.05, 0.0012, 15],
    ] },
  ] },
  { code: "FUR", ar: "الأثاث", en: "Furniture", gl: "150101", groups: [
    { code: "FRCHR", ar: "كراسي", en: "Chairs", items: [
      ["كرسي مكتب دوار بمساند", "Swivel office chair with arms", "EA", "asset", "", "D", 14, 0.35, 650],
      ["كرسي زائر ثابت", "Visitor chair", "EA", "asset", "", "D", 8, 0.25, 320],
      ["كرسي اجتماعات", "Meeting chair", "EA", "asset", "", "D", 10, 0.3, 480],
      ["كرسي ميداني قابل للطي", "Folding field chair", "EA", "stock", "", "D", 3, 0.03, 85],
    ] },
    { code: "FRDSK", ar: "مكاتب وطاولات", en: "Desks & tables", items: [
      ["مكتب موظف 140 سم", "Staff desk 140 cm", "EA", "asset", "", "D", 45, 0.6, 1250],
      ["طاولة اجتماعات 8 أشخاص", "Meeting table (8 seats)", "EA", "asset", "", "D", 80, 1.2, 3600],
      ["طاولة ميدانية قابلة للطي", "Folding field table", "EA", "stock", "", "D", 9, 0.06, 260],
    ] },
    { code: "FRSTO", ar: "وحدات تخزين", en: "Storage units", items: [
      ["خزانة ملفات معدنية 4 أدراج", "4-drawer steel filing cabinet", "EA", "asset", "", "D", 38, 0.4, 1150],
      ["رف تخزين معدني 5 طبقات", "5-tier steel shelving unit", "EA", "asset", "", "E", 30, 0.5, 690],
      ["خزانة حفظ آمنة", "Safe cabinet", "EA", "asset", "S", "E", 95, 0.3, 2800],
    ] },
  ] },
  { code: "ELC", ar: "المواد الكهربائية", en: "Electrical materials", gl: "140110", groups: [
    { code: "ELCBL", ar: "كابلات وأسلاك", en: "Cables & wires", items: [
      ["سلك كهرباء 2.5 مم (لفة 100 متر)", "Electrical wire 2.5 mm² (100 m)", "ROLL", "stock", "", "E", 3, 0.006, 145],
      ["سلك كهرباء 4 مم (لفة 100 متر)", "Electrical wire 4 mm² (100 m)", "ROLL", "stock", "", "E", 4.5, 0.008, 230],
      ["كابل تمديد خارجي 25 متر", "Outdoor extension cable 25 m", "EA", "stock", "", "D", 2.5, 0.006, 120],
      ["مواسير كهرباء PVC 20 مم", "PVC electrical conduit 20 mm", "EA", "stock", "", "D", 0.6, 0.003, 6],
    ] },
    { code: "ELLMP", ar: "إنارة", en: "Lighting", items: [
      ["لمبة LED 12 واط", "LED bulb 12 W", "EA", "consumable", "C", "D", 0.08, 0.0003, 9],
      ["كشاف LED خارجي 100 واط", "Outdoor LED floodlight 100 W", "EA", "stock", "", "E", 1.8, 0.004, 210],
      ["كشاف إنارة شمسي للمواقع", "Solar site floodlight", "EA", "stock", "S", "E", 4, 0.012, 650],
      ["لوح إنارة LED سقفي 60×60", "LED ceiling panel 60×60", "EA", "stock", "", "D", 2.5, 0.02, 95],
    ] },
    { code: "ELACC", ar: "قواطع ومفاتيح", en: "Breakers & switches", items: [
      ["قاطع كهربائي 20 أمبير", "Circuit breaker 20 A", "EA", "stock", "P", "E", 0.15, 0.0003, 28],
      ["قاطع تسرب أرضي 40 أمبير", "RCD 40 A", "EA", "stock", "P", "V", 0.3, 0.0005, 145],
      ["مفتاح إنارة مفرد", "Single light switch", "EA", "consumable", "", "D", 0.05, 0.0001, 7],
      ["فيش كهرباء ثلاثي", "3-pin power socket", "EA", "consumable", "", "D", 0.06, 0.0001, 9],
      ["شريط عازل كهربائي", "Electrical insulating tape", "ROLL", "consumable", "C", "D", 0.03, 0.00005, 3],
    ] },
  ] },
  { code: "VET", ar: "الأدوية والمستلزمات البيطرية", en: "Veterinary medicines & supplies", gl: "140111", critical: true, groups: [
    { code: "VTMED", ar: "أدوية بيطرية", en: "Veterinary medicines", items: [
      ["مضاد حيوي بيطري أوكسي تتراسيكلين", "Oxytetracycline veterinary antibiotic", "VIAL", "consumable", "BE", "V", 0.15, 0.0002, 42],
      ["مضاد طفيليات إيفرمكتين", "Ivermectin antiparasitic", "VIAL", "consumable", "BE", "V", 0.12, 0.0002, 58],
      ["مسكن ومضاد التهاب بيطري", "Veterinary NSAID analgesic", "VIAL", "consumable", "BE", "V", 0.1, 0.0002, 65],
      ["محلول وريدي رينجر لاكتات", "Ringer's lactate IV solution", "EA", "consumable", "BE", "V", 0.55, 0.0006, 9],
      ["مخدر بيطري للتعامل مع الحيوانات البرية", "Wildlife immobilisation anaesthetic", "VIAL", "consumable", "BE", "V", 0.05, 0.0001, 380],
      ["مرهم جروح بيطري", "Veterinary wound ointment", "EA", "consumable", "BE", "E", 0.1, 0.0002, 24],
    ] },
    { code: "VTVAC", ar: "لقاحات", en: "Vaccines", items: [
      ["لقاح الحمى القلاعية", "Foot-and-mouth disease vaccine", "DOSE", "consumable", "BE", "V", 0.01, 0.00002, 12],
      ["لقاح طاعون المجترات الصغيرة", "Peste des petits ruminants vaccine", "DOSE", "consumable", "BE", "V", 0.01, 0.00002, 9],
      ["لقاح التسمم المعوي", "Enterotoxaemia vaccine", "DOSE", "consumable", "BE", "V", 0.01, 0.00002, 7],
    ] },
    { code: "VTSUP", ar: "مستلزمات بيطرية", en: "Veterinary supplies", items: [
      ["محاقن 5 مل", "5 ml syringes", "BOX", "consumable", "BEC", "E", 0.4, 0.002, 28],
      ["إبر طبية مقاس 18G", "18G hypodermic needles", "BOX", "consumable", "BEC", "E", 0.2, 0.001, 22],
      ["قفازات فحص طبية", "Medical examination gloves", "BOX", "consumable", "BEC", "E", 0.5, 0.003, 18],
      ["سهام تخدير للبنادق البيطرية", "Tranquiliser darts", "BOX", "consumable", "BE", "V", 0.3, 0.001, 450],
      ["أطواق تتبع GPS للحيوانات البرية", "Wildlife GPS tracking collar", "EA", "asset", "S", "V", 0.9, 0.002, 7500],
      ["حاوية نقل حيوانات برية", "Wildlife transport crate", "EA", "asset", "S", "E", 60, 1.2, 4200],
    ] },
  ] },
];

/** Additional items appended to groups (brings the catalogue to 200). */
const EXTRA: Record<string, ItemRow[]> = {
  OFPAP: [["ورق حراري لطابعة الإيصالات", "Thermal receipt paper roll", "ROLL", "consumable", "C", "D", 0.1, 0.0003, 3],
          ["ملصقات عناوين A4", "A4 address labels", "PKT", "consumable", "", "D", 0.6, 0.002, 32]],
  OFDSK: [["سبورة بيضاء 120×90 سم", "Whiteboard 120×90 cm", "EA", "asset", "", "D", 9, 0.05, 240],
          ["لوح فلين للإعلانات", "Cork notice board", "EA", "consumable", "", "D", 3, 0.03, 85]],
  CLCHM: [["معطر جو", "Air freshener", "EA", "consumable", "BE", "D", 0.3, 0.0005, 9]],
  CLTOL: [["عربة تنظيف متعددة الأغراض", "Janitorial trolley", "EA", "asset", "", "D", 15, 0.4, 620]],
  VHENG: [["فلتر مكيف مقصورة", "Cabin air filter", "EA", "stock", "P", "E", 0.3, 0.003, 55]],
  VHTYR: [["إطار احتياطي 245/75R16", "Spare tyre 245/75R16", "EA", "stock", "S", "E", 15, 0.11, 690]],
  VHBRK: [["ذراع مقص أمامي سفلي", "Lower front control arm", "EA", "stock", "P", "E", 4, 0.006, 360]],
  SFPPE: [["حزام أمان للعمل على المرتفعات", "Fall-arrest safety harness", "EA", "stock", "S", "V", 1.8, 0.006, 340],
          ["سدادات أذن للحماية من الضوضاء", "Noise-protection ear plugs", "BOX", "consumable", "", "E", 0.2, 0.001, 30]],
  SFFIR: [["جهاز إنذار دخان", "Smoke detector", "EA", "stock", "", "V", 0.2, 0.0008, 75]],
  AGIRR: [["خرطوم ري مرن 50 متر", "Flexible garden hose 50 m", "EA", "stock", "", "D", 6, 0.03, 140]],
  CPRNG: [["جهاز قياس سرعة الرياح محمول", "Handheld anemometer", "EA", "asset", "S", "E", 0.3, 0.001, 540]],
  CPFLD: [["مجرفة ميدانية قابلة للطي", "Folding field shovel", "EA", "stock", "", "D", 1.1, 0.004, 75]],
  ITCMP: [["قرص صلب خارجي 2 تيرابايت", "External hard drive 2 TB", "EA", "asset", "S", "E", 0.2, 0.0004, 380]],
  ITNET: [["راوتر 4G ميداني", "Field 4G router", "EA", "asset", "S", "V", 0.5, 0.002, 890]],
  ELLMP: [["بطاريات قلم AA", "AA batteries", "PKT", "consumable", "BEC", "E", 0.1, 0.0002, 12]],
  FLOIL: [["زيت هيدروليك", "Hydraulic oil", "L", "consumable", "BE", "E", 0.9, 0.0012, 18]],
  VTSUP: [["ميزان حرارة بيطري رقمي", "Digital veterinary thermometer", "EA", "consumable", "", "E", 0.05, 0.0001, 45]],
  FDFED: [["ذرة صفراء مجروشة 50 كجم", "Cracked yellow corn 50 kg", "BAG", "consumable", "BE", "V", 50, 0.07, 75]],
};
for (const c of CATALOG) for (const g of c.groups) if (EXTRA[g.code]) g.items.push(...EXTRA[g.code]);
