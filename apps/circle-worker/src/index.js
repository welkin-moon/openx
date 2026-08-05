import { manifests, verifyEvent } from "../../../packages/protocol/index.js";
import { handle, HttpError, json, options, readJson, requireBearer } from "../../../packages/worker-kit/index.js";

function manifest(env, request) {
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  return {
    version: manifests.circle,
    role: "strong-circle",
    did: env.CIRCLE_DID,
    baseUrl: base,
    storesBodies: false,
    capabilities: ["submission", "admission", "moderation", "governance", "checkpoint"],
    endpoints: { ingest: `${base}/openx/v1/events`, feed: `${base}/openx/v1/feed`, manifest: `${base}/openx/v1/manifest` }
  };
}

async function ingest(request, env) {
  requireBearer(request, env.CIRCLE_API_TOKEN);
  const event = await readJson(request);
  await verifyEvent(event);
  if (!event.kind.startsWith("circle.")) throw new HttpError(422, "wrong_kind", "only circle.* events are accepted");
  await env.STATE.put(`event:${event.id}`, JSON.stringify(event));
  const object = event.payload.object;
  if (object && event.kind === "circle.admit") await env.STATE.put(`feed:${event.createdAt}:${event.id}`, JSON.stringify({ object, source: event.payload.source, admittedBy: event.actor, eventId: event.id }));
  if (object && event.kind === "circle.reject") await env.STATE.delete(`object:${object}`);
  if (object && event.kind === "circle.submit") await env.STATE.put(`submission:${object}`, JSON.stringify(event));
  if (event.kind.startsWith("circle.governance.") || event.kind.startsWith("circle.moderation.")) await env.STATE.put(`governance:${event.createdAt}:${event.id}`, JSON.stringify(event));
  return json({ ok: true, eventId: event.id }, { status: 201 });
}

async function feed(env, limit) {
  const keys = await env.STATE.list({ prefix: "feed:", limit: Math.min(limit, 200) });
  const values = await Promise.all(keys.keys.map((key) => env.STATE.get(key.name, "json")));
  return values.filter(Boolean).reverse();
}

async function route(request, env) {
  if (request.method === "OPTIONS") return options();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, role: "strong-circle" });
  if (request.method === "GET" && url.pathname === "/openx/v1/manifest") return json(manifest(env, request));
  if (request.method === "POST" && url.pathname === "/openx/v1/events") return ingest(request, env);
  if (request.method === "GET" && url.pathname === "/openx/v1/feed") return json({ circle: env.CIRCLE_DID, items: await feed(env, Number(url.searchParams.get("limit") || 100)) });
  throw new HttpError(404, "not_found", "route not found");
}

export default { fetch(request, env) { return handle(request, () => route(request, env)); } };
