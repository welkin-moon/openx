import test from "node:test";
import assert from "node:assert/strict";
import { queuedEvent } from "../packages/outbox/index.js";
import { flushOutbox, postEventBatch } from "../packages/outbox/http.js";

function event(id) {
  return { id, createdAt: "2026-08-05T00:00:00Z", version: "openx-event/1" };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("postEventBatch sends bearer-authenticated JSON", async () => {
  let request = null;
  const result = await postEventBatch(
    "https://node.example/openx/v1/events/batch",
    "secret",
    [event("sha256:a")],
    async (url, init) => {
      request = { url, init };
      return jsonResponse(201, { eventIds: ["sha256:a"], commit: "abc" });
    }
  );

  assert.equal(request.url, "https://node.example/openx/v1/events/batch");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.init.body).events.map((item) => item.id), ["sha256:a"]);
  assert.equal(result.commit, "abc");
});

test("flushOutbox commits acknowledged events", async () => {
  const entries = [queuedEvent(event("sha256:a"), 0)];
  const outcome = await flushOutbox(entries, {
    endpoint: "https://node.example/openx/v1/events/batch",
    token: "secret",
    fetchImpl: async () => jsonResponse(201, {
      eventIds: ["sha256:a"],
      commit: "abc"
    })
  }, 20_000);

  assert.equal(outcome.entries[0].state, "committed");
  assert.equal(outcome.entries[0].receipt.commit, "abc");
});

test("flushOutbox observes Retry-After on rate limits", async () => {
  const entries = [queuedEvent(event("sha256:a"), 0)];
  const outcome = await flushOutbox(entries, {
    endpoint: "https://node.example/openx/v1/events/batch",
    token: "secret",
    fetchImpl: async () => jsonResponse(429, {
      error: "rate_limited",
      message: "slow down"
    }, { "retry-after": "30" })
  }, 20_000);

  assert.equal(outcome.entries[0].state, "queued");
  assert.equal(outcome.entries[0].nextAttemptAt, 50_000);
  assert.equal(outcome.entries[0].lastError, "rate_limited");
});
