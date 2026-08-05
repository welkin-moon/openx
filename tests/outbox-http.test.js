import test from "node:test";
import assert from "node:assert/strict";
import { OUTBOX_STATES, queuedEvent } from "../packages/outbox/index.js";
import { flushOutbox, postEventBatch, postEventBatchWithSplit } from "../packages/outbox/http.js";

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

  assert.equal(outcome.entries[0].state, OUTBOX_STATES.committed);
  assert.equal(outcome.entries[0].receipt.commit, "abc");
});

test("flushOutbox observes Retry-After on rate limits", async () => {
  const entries = [queuedEvent(event("sha256:a"), 0)];
  const outcome = await flushOutbox(entries, {
    endpoint: "https://node.example/openx/v1/events/batch",
    token: "secret",
    random: () => 0.5,
    fetchImpl: async () => jsonResponse(429, {
      error: "rate_limited",
      message: "slow down"
    }, { "retry-after": "30" })
  }, 20_000);

  assert.equal(outcome.entries[0].state, OUTBOX_STATES.retryWait);
  assert.equal(outcome.entries[0].nextAttemptAt, 50_000);
  assert.equal(outcome.entries[0].lastError, "rate_limited");
});

test("413 recursively splits a batch until accepted", async () => {
  const requestSizes = [];
  const result = await postEventBatchWithSplit(
    "https://node.example/openx/v1/events/batch",
    "secret",
    [event("sha256:a"), event("sha256:b"), event("sha256:c"), event("sha256:d")],
    async (_url, init) => {
      const events = JSON.parse(init.body).events;
      requestSizes.push(events.length);
      if (events.length > 1) return jsonResponse(413, { error: "too_large" });
      return jsonResponse(201, { eventIds: events.map((item) => item.id), commit: `commit-${events[0].id}` });
    }
  );

  assert.deepEqual(result.eventIds, ["sha256:a", "sha256:b", "sha256:c", "sha256:d"]);
  assert.deepEqual(requestSizes, [4, 2, 1, 1, 2, 1, 1]);
});

test("partial split success is retained when a later child fails", async () => {
  const entries = [
    queuedEvent(event("sha256:a"), 0),
    queuedEvent(event("sha256:b"), 1)
  ];
  const outcome = await flushOutbox(entries, {
    endpoint: "https://node.example/openx/v1/events/batch",
    token: "secret",
    fetchImpl: async (_url, init) => {
      const events = JSON.parse(init.body).events;
      if (events.length > 1) return jsonResponse(413, { error: "too_large" });
      if (events[0].id === "sha256:a") {
        return jsonResponse(201, { eventIds: ["sha256:a"], commit: "commit-a" });
      }
      return jsonResponse(422, { error: "bad_signature" });
    }
  }, 20_000);

  assert.equal(outcome.entries[0].state, OUTBOX_STATES.committed);
  assert.equal(outcome.entries[1].state, OUTBOX_STATES.rejectedInvalid);
  assert.equal(outcome.entries[1].lastError, "bad_signature");
});
