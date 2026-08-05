export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJson(request, maxBytes = 2_000_000) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new HttpError(413, "too_large", "request body too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large", "request body too large");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "bad_json", "invalid JSON"); }
}

export function requireBearer(request, expected) {
  if (!expected) throw new HttpError(503, "not_configured", "server token is not configured");
  if (request.headers.get("authorization") !== `Bearer ${expected}`) throw new HttpError(401, "unauthorized", "invalid bearer token");
}

export function options() {
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  }});
}

export async function handle(request, fn) {
  try { return await fn(); }
  catch (error) {
    console.error(error);
    return json({ error: error.code ?? "internal_error", message: error.message ?? "internal error" }, { status: error.status ?? 500 });
  }
}
