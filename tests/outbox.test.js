import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledge,
  classifyOutboxFailure,
  markSending,
  OUTBOX_STATES,
  parseRetryAfter,
  planFlush,
  queuedEvent,
  recoverSending,
  rejectOrRetry,
  retryDelay,
  shouldFlush,
  unblock
} from "../packages/outbox/index.js";

function event(id, createdAt = "2026-08-05T00:00:00Z") {
  return { id, createdAt, version: "openx-event/1" };
}

const deterministicPolicy = {
  flushAfterMs: 15_000,
  maxBatchEvents: 100,
  maxBatchBytes: 4_000_000,
  baseRetryMs: 1_000,
  maxRetryMs: 900_000,
  sendingLeaseMs: 60_000,
  jitterRatio: 0
};

test("outbox flushes after the policy delay", () => {
  const entries = [queuedEvent(event("sha256:a"), 1_000)];
  assert.equal(shouldFlush(entries, deterministicPolicy, 15_999), false);
  assert.equal(shouldFlush(entries, deterministicPolicy, 16_000), true);
});

test("immediate delivery bypasses the 15 second delay", () => {
  const entries = [queuedEvent(event("sha256:a"), 1_000, { delivery: "immediate" })];
  assert.equal(shouldFlush(entries, deterministicPolicy, 1_000), true);
});

test("planFlush preserves queue order and event limit", () => {
  const policy = { ...deterministicPolicy, maxBatchEvents: 2 };
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
  assert.equal(entries[0].state, OUTBOX_STATES.committed);
  assert.equal(entries[0].receipt.commit, "abc");
  assert.equal(entries[1].state, OUTBOX_STATES.queued);
});

test("expired sending lease returns event to queue after a crash", () => {
  let entries = [queuedEvent(event("sha256:a"), 1)];
  entries = markSending(entries, ["sha256:a"], 10);
  assert.equal(recoverSending(entries, deterministicPolicy, 60_009)[0].state, OUTBOX_STATES.sending);
  const recovered = recoverSending(entries, deterministicPolicy, 60_010)[0];
  assert.equal(recovered.state, OUTBOX_STATES.queued);
  assert.equal(recovered.lastError, "sending_lease_expired");
});

test("network and server errors enter retry_wait", () => {
  let entries = [queuedEvent(event("sha256:a"), 1)];
  entries = markSending(entries, ["sha256:a"], 10);
  entries = rejectOrRetry(entries, ["sha256:a"], { status: 503, code: "unavailable" }, deterministicPolicy, 20, () => 0.5);
  assert.equal(entries[0].state, OUTBOX_STATES.retryWait);
  assert.equal(entries[0].nextAttemptAt, 20 + retryDelay(1, deterministicPolicy, () => 0.5));
});

test("Retry-After overrides exponential delay", () => {
  let entries = [queuedEvent(event("sha256:a"), 1)];
  entries = markSending(entries, ["sha256:a"], 10);
  entries = rejectOrRetry(entries, ["sha256:a"], {
    status: 429,
    code: "rate_limited",
    retryAfterMs: 30_000
  }, deterministicPolicy, 20);
  assert.equal(entries[0].state, OUTBOX_STATES.retryWait);
  assert.equal(entries[0].nextAttemptAt, 30_020);
});

test("Retry-After parses seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("15", 1_000), 15_000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:20 GMT", 5_000), 15_000);
  assert.equal(parseRetryAfter("invalid", 5_000), null);
});

test("401 and 403 block without discarding the event", () => {
  let entries = [queuedEvent(event("sha256:a"), 1), queuedEvent(event("sha256:b"), 2)];
  entries = markSending(entries, ["sha256:a", "sha256:b"], 10);
  const auth = rejectOrRetry(entries, ["sha256:a"], { status: 401, code: "expired_token" }, deterministicPolicy, 20);
  const permission = rejectOrRetry(auth, ["sha256:b"], { status: 403, code: "missing_scope" }, deterministicPolicy, 20);
  assert.equal(permission[0].state, OUTBOX_STATES.blockedAuth);
  assert.equal(permission[1].state, OUTBOX_STATES.blockedPermission);
  const resumed = unblock(permission, [OUTBOX_STATES.blockedAuth], 30);
  assert.equal(resumed[0].state, OUTBOX_STATES.queued);
  assert.equal(resumed[1].state, OUTBOX_STATES.blockedPermission);
});

test("immutable conflicts are terminal conflict rejections", () => {
  let entries = [queuedEvent(event("sha256:a"), 1)];
  entries = markSending(entries, ["sha256:a"], 10);
  entries = rejectOrRetry(entries, ["sha256:a"], { status: 409, code: "immutable_object_conflict" }, deterministicPolicy, 20);
  assert.equal(entries[0].state, OUTBOX_STATES.rejectedConflict);
});

test("batch 413 requests split while a single oversized event is terminal", () => {
  assert.deepEqual(classifyOutboxFailure({ status: 413, code: "too_large" }, 2), {
    state: OUTBOX_STATES.queued,
    code: "too_large",
    splitRequired: true
  });
  assert.equal(classifyOutboxFailure({ status: 413 }, 1).state, OUTBOX_STATES.rejectedTooLarge);
});

test("400 and 422 are invalid-event rejections", () => {
  assert.equal(classifyOutboxFailure({ status: 400 }).state, OUTBOX_STATES.rejectedInvalid);
  assert.equal(classifyOutboxFailure({ status: 422 }).state, OUTBOX_STATES.rejectedInvalid);
});
