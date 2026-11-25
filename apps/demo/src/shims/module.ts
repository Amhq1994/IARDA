// node:module stand-in: the report exporter (Chromium / ExcelJS / pptxgenjs) runs on the server and is not bundled
// in the demo. Report downloads answer with a clear "server only" message instead.
import { ApiError } from "../../../api/src/lib/errors.ts";

const unavailable = () => {
  throw new ApiError(501, "demo_unavailable", "تصدير التقارير إلى ملفات يعمل على الخادم فقط — غير متاح في نسخة العرض",
    "Report file export runs on the server only — not available in the demo");
};
export function createRequire(_url?: string) { return () => ({ exportPdf: unavailable, exportXlsx: unavailable, exportPptx: unavailable }); }
export default { createRequire };
