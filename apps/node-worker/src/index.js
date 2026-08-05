import { manifests, relayRecord, verifyEvent } from "../../../packages/protocol/index.js";
import { createGitProvider } from "../../../packages/git-provider/index.js";
import { handle, HttpError, json, options, readJson, requireBearer } from "../../../packages/worker-kit/index.js";

function manifest(env, request) {
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  const storage = createGitProvider(env).descriptor();
  return {
    version: manifests.node,
    role: "user-node",
    did: env.NODE_DID,
    baseUrl: base,
    ciphertextOnly: true,
    storage,
    endpoints: {
      events: `${base}/openx/v1/events`,
      media: `${base}/openx/v1/media/{sha256}`,
      manifest: `${base}/openx/v1/manifest`
    },
    clientCompatibility: {
      event: "openx-event/1",
      signatures: ["Ed25519"],
      payloads: ["ciphertext", "public-metadata"]
    }
  };
}

async function createEvent(request, env) {
  requireBearer(request, env.NODE_API_TOKEN);
  const event = await readJson(request);
  await verifyEvent(event);
  const provider = createGitProvider(env);
  const stamp = event.createdAt.replaceAll(":", "-");
  const path = `events/inbox/${stamp}-${event.id.slice(7, 23)}.json`;
  const result = await provider.putBytes(path, JSON.stringify(event), {
    message: `openx: append ${event.kind}`
  });
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  return json({
    ok: true,
    eventId: event.id,
    commit: result.commit,
    location: result.location,
    relayRecord: relayRecord(event, `${base}/objects/${event.id}`)
  }, { status: 201 });
}

async function putMedia(request, env, hash) {
  requireBearer(request, env.NODE_API_TOKEN);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new HttpError(400, "bad_hash", "expected lowercase SHA-256");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > Number(env.MAX_MEDIA_CHUNK_BYTES || 8_388_608)) throw new HttpError(413, "too_large", "media chunk too large");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== hash) throw new HttpError(422, "hash_mismatch", "media hash mismatch");
  const provider = createGitProvider(env);
  const path = `media/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.bin`;
  const result = await provider.putBytes(path, bytes, { message: `openx: store media ${hash}` });
  return json({ ok: true, hash, commit: result.commit, location: result.location }, { status: 201 });
}

async function route(request, env) {
  if (request.method === "OPTIONS") return options();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, role: "user-node" });
  if (request.method === "GET" && url.pathname === "/openx/v1/manifest") return json(manifest(env, request));
  if (request.method === "POST" && url.pathname === "/openx/v1/events") return createEvent(request, env);
  const media = url.pathname.match(/^\/openx\/v1\/media\/([a-f0-9]{64})$/u);
  if (request.method === "PUT" && media) return putMedia(request, env, media[1]);
  throw new HttpError(404, "not_found", "route not found");
}

export default {
  fetch(request, env) {
    return handle(request, () => route(request, env));
  }
};
