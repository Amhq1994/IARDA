// Thin fetch wrapper: same-origin cookies, CSRF header, bilingual API errors.

export interface ApiErrorBody { code: string; message_ar: string; message_en: string; details?: any }

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(body.message_en); }
  get code() { return this.body.code; }
  message_for(lang: string) { return lang === "ar" ? this.body.message_ar : this.body.message_en; }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "x-requested-with": "iarda-wms",
      ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data.error ?? { code: "http_" + res.status, message_ar: "حدث خطأ", message_en: "Request failed" });
    if (res.status === 401 && !url.includes("/auth/")) window.dispatchEvent(new Event("wms:unauthenticated"));
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string, params?: Record<string, unknown>) => {
    const qs = params
      ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString()
      : "";
    return request<T>("GET", url + (qs === "?" ? "" : qs));
  },
  post: <T = any>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>("PATCH", url, body),
  put: <T = any>(url: string, body: unknown) => request<T>("PUT", url, body),
  del: <T = any>(url: string) => request<T>("DELETE", url),
};

export interface Page<T> { data: T[]; total: number; page: number; pageSize: number }
