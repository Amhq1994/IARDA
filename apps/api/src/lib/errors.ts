// Bilingual API errors: { error: { code, message_ar, message_en, details? } }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public messageAr: string,
    public messageEn: string,
    public details?: unknown
  ) {
    super(messageEn);
  }
}

export const E = {
  unauthenticated: () => new ApiError(401, "unauthenticated", "يجب تسجيل الدخول", "Authentication required"),
  forbidden: (perm?: string) =>
    new ApiError(403, "forbidden", "لا تملك صلاحية تنفيذ هذا الإجراء", "You do not have permission for this action", perm ? { permission: perm } : undefined),
  outOfScope: () => new ApiError(403, "out_of_scope", "هذا السجل خارج نطاق صلاحياتك", "This record is outside your data scope"),
  notFound: (what = "record") => new ApiError(404, "not_found", "السجل غير موجود", `${what} not found`),
  conflict: (code: string, ar: string, en: string, details?: unknown) => new ApiError(409, code, ar, en, details),
  invalid: (details: unknown) => new ApiError(422, "validation_failed", "البيانات المدخلة غير صحيحة", "Validation failed", details),
  sod: (rule: string, ar: string, en: string) => new ApiError(409, "segregation_of_duties", ar, en, { rule }),
  state: (from: string, action: string) =>
    new ApiError(409, "invalid_state", "لا يمكن تنفيذ الإجراء في الحالة الحالية", `Cannot ${action} from status "${from}"`, { from, action }),
  stale: () => new ApiError(409, "stale_version", "تم تعديل السجل من مستخدم آخر، يرجى التحديث", "Record was changed by someone else; reload and retry"),
};

/** Maps PostgreSQL errors raised by constraints/triggers to API errors. */
export function fromPg(e: any): ApiError | null {
  if (!e || typeof e.code !== "string") return null;
  switch (e.code) {
    case "23505":
      return new ApiError(409, "duplicate", "القيمة مستخدمة مسبقاً", "Value already exists", { constraint: e.constraint, detail: e.detail });
    case "23503":
      return new ApiError(422, "invalid_reference", "مرجع غير صحيح", "Referenced record does not exist", { constraint: e.constraint });
    case "23514":
      return new ApiError(422, "constraint_violation", "القيمة تخالف قواعد البيانات", "Value violates a business rule", { constraint: e.constraint });
    case "P0001":
      return new ApiError(409, e.hint || "rule_violation", "تم رفض العملية وفق قواعد النظام", e.message, { hint: e.hint });
    case "42501":
      return new ApiError(403, "db_forbidden", "العملية غير مسموحة", "Operation not permitted");
    default:
      return null;
  }
}
