import { manifests, relayRecord, sha256, verifyEvent } from "../../../packages/protocol/index.js";
import { createGitProvider, GitConflictError } from "../../../packages/git-provider/index.js";
import { batchObjectPath, eventObjectPath, mediaObjectPath } from "../../../packages/storage-layout/index.js";
import { handle, HttpError, json, options, readJson, requireBearer } from "../../../packages/worker-kit/index.js";

function eventLocation(location, eventId, index = null) {
  return {
    ...location,
    eventId,
    ...(index === null ? {} : { ndjsonIndex: index })
  };
}

function storageError(error) {
  if (error instanceof GitConflictError || error?.code === "git_object_conflict") {
    return new HttpError(409, "immutable_object_conflict", error.message);
  }
  return error;
}

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
    writeModel: {
      durableBuffer: false,
      canonicalLog: "git-immutable-objects",
      discussionWorkspace: false,
      idempotency: "content-addressed-path",
      batchAtomicity: "single-git-tree-commit"
    },
    endpoints: {
      events: `${base}/openx/v1/events`,
      eventBatch: `${base}/openx/v1/events/batch`,
      media: `${base}/openx/v1/media/{sha256}`,
      manifest: `${base}/openx/v1/manifest`
    },
    clientCompatibility: {
      event: "openx-event/1",
      signatures: ["Ed25519"],
      payloads: ["ciphertext", "public-metadata"],
      retryOwnership: "client"
    }
  };
}

async function createEvent(request, env) {
  requireBearer(request, env.NODE_API_TOKEN);
  const event = await readJson(request);
  await verifyEvent(event);

  const provider = createGitProvider(env);
  try {
    const result = await provider.putBytes(eventObjectPath(event.id, event.createdAt), `${JSON.stringify(event)}\n`, {
      message: `openx: append ${event.kind}`
    });
    const source = eventLocation(result.location, event.id);

    return json({
      ok: true,
      eventId: event.id,
      commit: result.commit,
      idempotent: result.idempotent,
      location: source,
      relayRecord: relayRecord(event, source)
    }, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    throw storageError(error);
  }
}

async function createEventBatch(request, env) {
  requireBearer(request, env.NODE_API_TOKEN);
  const input = await readJson(request, Number(env.MAX_EVENT_BATCH_BYTES || 4_000_000));
  const events = Array.isArray(input) ? input : input?.events;
  const maxEvents = Number(env.MAX_EVENT_BATCH_SIZE || 100);

  if (!Array.isArray(events) || events.length === 0) {
    throw new HttpError(400, "empty_batch", "events must be a non-empty array");
  }
  if (events.length > maxEvents) {
    throw new HttpError(413, "batch_too_large", `event batch exceeds ${maxEvents} entries`);
  }

  for (const event of events) await verifyEvent(event);

  const ndjson = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const digest = await sha256(ndjson);
  const dataPath = batchObjectPath(digest, events[0].createdAt);
  const receiptPath = `receipts/batches/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.json`;
  const receipt = {
    version: "openx-batch-receipt/1",
    batch: `sha256:${digest}`,
    count: events.length,
    eventIds: events.map((event) => event.id),
    object: dataPath,
    createdAt: events[0].createdAt
  };

  const provider = createGitProvider(env);
  try {
    const result = await provider.putManyBytes([
      { path: dataPath, bytes: ndjson },
      { path: receiptPath, bytes: `${JSON.stringify(receipt)}\n` }
    ], { message: `openx: append ${events.length} events` });

    const batchLocation = result.locations[0];
    return json({
      ok: true,
      count: events.length,
      batch: `sha256:${digest}`,
      commit: result.commit,
      idempotent: result.idempotent,
      location: batchLocation,
      receipt: result.locations[1],
      eventIds: receipt.eventIds,
      relayRecords: events
        .map((event, index) => relayRecord(event, eventLocation(batchLocation, event.id, index)))
        .filter(Boolean)
    }, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    throw storageError(error);
  }
}

async function putMedia(request, env, hash) {
  requireBearer(request, env.NODE_API_TOKEN);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new HttpError(400, "bad_hash", "expected lowercase SHA-256");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > Number(env.MAX_MEDIA_CHUNK_BYTES || 8_388_608)) {
    throw new HttpError(413, "too_large", "media chunk too large");
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== hash) throw new HttpError(422, "hash_mismatch", "media hash mismatch");

  const provider = createGitProvider(env);
  try {
    const result = await provider.putBytes(mediaObjectPath(hash), bytes, { message: `openx: store media ${hash}` });
    return json({
      ok: true,
      hash,
      commit: result.commit,
      idempotent: result.idempotent,
      location: result.location
    }, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    throw storageError(error);
  }
}

async function route(request, env) {
  if (request.method === "OPTIONS") return options();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, role: "user-node" });
  if (request.method === "GET" && url.pathname === "/openx/v1/manifest") return json(manifest(env, request));
  if (request.method === "POST" && url.pathname === "/openx/v1/events") return createEvent(request, env);
  if (request.method === "POST" && url.pathname === "/openx/v1/events/batch") return createEventBatch(request, env);
  const media = url.pathname.match(/^\/openx\/v1\/media\/([a-f0-9]{64})$/u);
  if (request.method === "PUT" && media) return putMedia(request, env, media[1]);
  throw new HttpError(404, "not_found", "route not found");
}

export default {
  fetch(request, env) {
    return handle(request, () => route(request, env));
  }
};
