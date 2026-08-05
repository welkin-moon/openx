import { manifests } from "../../../packages/protocol/index.js";
import { createRelayStore } from "../../../packages/relay-store/index.js";
import { handle, HttpError, json, options, readJson, requireBearer } from "../../../packages/worker-kit/index.js";

function manifest(env, request) {
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  return {
    version: manifests.relay,
    role: "relay",
    did: env.RELAY_DID,
    baseUrl: base,
    storesBodies: false,
    deployment: {
      runtime: env.RUNTIME_KIND || "cloudflare-worker",
      store: env.RELAY_STORE || "cloudflare-kv",
      selfHostable: true
    },
    capabilities: ["announce", "tag-index", "interaction-edge", "attestation", "value-label"],
    endpoints: {
      ingest: `${base}/openx/v1/ingest`,
      tags: `${base}/openx/v1/tags/{tag}`,
      object: `${base}/openx/v1/objects/{id}`
    }
  };
}

async function ingest(request, env) {
  requireBearer(request, env.RELAY_API_TOKEN);
  const batch = await readJson(request, 5_000_000);
  if (!Array.isArray(batch.records) || !batch.source) {
    throw new HttpError(422, "bad_batch", "source and records are required");
  }

  for (const record of batch.records) {
    if (!record.eventId || !record.kind || !record.actor || !record.source) {
      throw new HttpError(422, "bad_record", "relay records need eventId, kind, actor and source");
    }
  }

  await createRelayStore(env).ingest(batch.records);
  return json({ ok: true, accepted: batch.records.length });
}

async function route(request, env) {
  if (request.method === "OPTIONS") return options();
  const url = new URL(request.url);
  const store = createRelayStore(env);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ ok: true, role: "relay" });
  }
  if (request.method === "GET" && url.pathname === "/openx/v1/manifest") {
    return json(manifest(env, request));
  }
  if (request.method === "POST" && url.pathname === "/openx/v1/ingest") {
    return ingest(request, env);
  }

  const tag = url.pathname.match(/^\/openx\/v1\/tags\/(.+)$/u);
  if (request.method === "GET" && tag) {
    const decoded = decodeURIComponent(tag[1]);
    return json({
      tag: decoded,
      records: await store.listTag(decoded, Number(url.searchParams.get("limit") || 100))
    });
  }

  const object = url.pathname.match(/^\/openx\/v1\/objects\/(.+)$/u);
  if (request.method === "GET" && object) {
    const id = decodeURIComponent(object[1]);
    const record = await store.getObject(id);
    if (!record) throw new HttpError(404, "not_found", "object not indexed");
    return json({
      record,
      trustworthyInteractions: await store.listInteractions(id, 500),
      attestationsAndLabels: await store.listTrust(id, 100)
    });
  }

  throw new HttpError(404, "not_found", "route not found");
}

export default {
  fetch(request, env) {
    return handle(request, () => route(request, env));
  }
};
