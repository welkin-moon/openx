import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledge,
  markSending,
  planFlush,
  queuedEvent,
  rejectOrRetry,
  retryDelay,
  shouldFlush
} from "../packages/outbox/index.js";

function event(id, createdAt = "2026-08-05T00:00:00Z") {
  return { id, createdAt, version: "openx-event/1" };
}

test("outbox flushes after the policy delay", () => {
  const policy = { flushAfterMs: 15_000, maxBatchEvents: 100, maxBatchBytes: 4_000_000, baseRetryMs: 1000, maxRetryMs: 900_000 };
  const entries = [queuedEvent(event("sha256:a"), 1_000)];
  assert.equal(shouldFlush(entries, policy, 15_999), false);
  assert.equal(shouldFlush(entries, policy, 16_000), true);
});

test("planFlush preserves queue order and event limit", () => {
  const policy = { flushAfterMs: 15_000, maxBatchEvents: 2, maxBatchBytes: 4_000_000, baseRetryMs: 1000, maxRetryMs: 900_000 };
  const entries = [
    queuedEvent(event("sha256:b"), 2),
    queuedEvent(event("sha256:a"), 1),
    queuedEvent(event("sha256:c"), 3)
  ];
  assert.deepEqual(planFlush(entries, policy, 10).eventIds, ["sha256:a", "sha256:b"]);
});

test("successful commit acknowledges only selected events", () => {
  let entries = [queuedEvent(event("sha256:a"), 1), queuedEvent(event("sha256:b"), 2)];
  entries = markSending(entries, ["sha256:a"], 10);
  entries = acknowledge(entries, ["sha256:a"], { commit: "abc" }, 20);
  assert.equal(entries[0].state, "committed");
  assert.equal(entries[0].receipt.commit, "abc");
  assert.equal(entries[1].state, "queued");
});

test("network and server errors retry with exponential delay", () => {
  let entries = [queuedEvent(event("sha256:a"), 1)];
  entries = markSending(entries, ["sha256:a"], 10);
  entries = rejectOrRetry(entries, ["sha256:a"], { status: 503, code: "unavailable" }, undefined, 20);
  assert.equal(entries[0].state, "queued");
  assert.equal(entries[0].nextAttemptAt, 20 + retryDelay(1));
});

test("immutable conflicts are permanent rejections", () => {
  let entries = [queuedEvent(event("sha256:a"), 1)];
  entries = markSending(entries, ["sha256:a"], 10);
  entries = rejectOrRetry(entries, ["sha256:a"], { status: 409, code: "immutable_object_conflict" }, undefined, 20);
  assert.equal(entries[0].state, "rejected");
  assert.equal(entries[0].lastError, "immutable_object_conflict");
});
