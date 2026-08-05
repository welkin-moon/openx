import { manifests } from "../../../packages/protocol/index.js";
import { handle, HttpError, json, options, readJson, requireBearer } from "../../../packages/worker-kit/index.js";

function manifest(env, request) {
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  return {
    version: manifests.relay,
    role: "relay",
    did: env.RELAY_DID,
    baseUrl: base,
    storesBodies: false,
    capabilities: ["announce", "tag-index", "interaction-edge", "attestation", "value-label"],
    endpoints: { ingest: `${base}/openx/v1/ingest`, tags: `${base}/openx/v1/tags/{tag}`, object: `${base}/openx/v1/objects/{id}` }
  };
}

async function ingest(request, env) {
  requireBearer(request, env.RELAY_API_TOKEN);
  const batch = await readJson(request, 5_000_000);
  if (!Array.isArray(batch.records) || !batch.source) throw new HttpError(422, "bad_batch", "source and records are required");
  for (const record of batch.records) {
    if (!record.eventId || !record.kind || !record.actor || !record.source) throw new HttpError(422, "bad_record", "relay records need eventId, kind, actor and source");
    await env.INDEX.put(`event:${record.eventId}`, JSON.stringify(record));
    if (record.object) await env.INDEX.put(`object:${record.object}`, JSON.stringify(record));
    for (const tag of record.tags ?? []) {
      const key = `tag:${encodeURIComponent(String(tag).toLowerCase())}:${record.createdAt}:${record.eventId}`;
      await env.INDEX.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
    }
    if (record.target && record.kind.startsWith("reaction.")) {
      await env.INDEX.put(`interaction:${record.target}:${record.actor}:${record.reaction ?? "like"}`, JSON.stringify(record));
    }
    if (record.target && (record.kind.startsWith("attestation.") || record.kind.startsWith("label."))) {
      await env.INDEX.put(`trust:${record.target}:${record.issuer}:${record.eventId}`, JSON.stringify(record));
    }
  }
  return json({ ok: true, accepted: batch.records.length });
}

async function listPrefix(env, prefix, limit = 100) {
  const keys = await env.INDEX.list({ prefix, limit: Math.min(limit, 500) });
  const values = await Promise.all(keys.keys.map((key) => env.INDEX.get(key.name, "json")));
  return values.filter(Boolean);
}

async function route(request, env) {
  if (request.method === "OPTIONS") return options();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, role: "relay" });
  if (request.method === "GET" && url.pathname === "/openx/v1/manifest") return json(manifest(env, request));
  if (request.method === "POST" && url.pathname === "/openx/v1/ingest") return ingest(request, env);
  const tag = url.pathname.match(/^\/openx\/v1\/tags\/(.+)$/u);
  if (request.method === "GET" && tag) return json({ tag: decodeURIComponent(tag[1]), records: await listPrefix(env, `tag:${encodeURIComponent(decodeURIComponent(tag[1]).toLowerCase())}:`, Number(url.searchParams.get("limit") || 100)) });
  const object = url.pathname.match(/^\/openx\/v1\/objects\/(.+)$/u);
  if (request.method === "GET" && object) {
    const record = await env.INDEX.get(`object:${decodeURIComponent(object[1])}`, "json");
    if (!record) throw new HttpError(404, "not_found", "object not indexed");
    const interactions = await listPrefix(env, `interaction:${decodeURIComponent(object[1])}:`, 500);
    const trust = await listPrefix(env, `trust:${decodeURIComponent(object[1])}:`, 100);
    return json({ record, trustworthyInteractions: interactions, attestationsAndLabels: trust });
  }
  throw new HttpError(404, "not_found", "route not found");
}

export default { fetch(request, env) { return handle(request, () => route(request, env)); } };
