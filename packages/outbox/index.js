const encoder = new TextEncoder();

export const DEFAULT_OUTBOX_POLICY = Object.freeze({
  flushAfterMs: 15_000,
  maxBatchEvents: 100,
  maxBatchBytes: 4_000_000,
  baseRetryMs: 1_000,
  maxRetryMs: 15 * 60_000,
  sendingLeaseMs: 60_000,
  jitterRatio: 0.2
});

export const OUTBOX_STATES = Object.freeze({
  queued: "queued",
  sending: "sending",
  committed: "committed",
  retryWait: "retry_wait",
  blockedAuth: "blocked_auth",
  blockedPermission: "blocked_permission",
  blockedConfiguration: "blocked_configuration",
  rejectedInvalid: "rejected_invalid",
  rejectedConflict: "rejected_conflict",
  rejectedTooLarge: "rejected_too_large"
});

const RETRYABLE_STATES = new Set([OUTBOX_STATES.queued, OUTBOX_STATES.retryWait]);
const BLOCKED_STATES = new Set([
  OUTBOX_STATES.blockedAuth,
  OUTBOX_STATES.blockedPermission,
  OUTBOX_STATES.blockedConfiguration
]);
const TERMINAL_STATES = new Set([
  OUTBOX_STATES.committed,
  OUTBOX_STATES.rejectedInvalid,
  OUTBOX_STATES.rejectedConflict,
  OUTBOX_STATES.rejectedTooLarge
]);

function eventBytes(event) {
  return encoder.encode(`${JSON.stringify(event)}\n`).byteLength;
}

function eligible(entry, now) {
  return RETRYABLE_STATES.has(entry.state) && Number(entry.nextAttemptAt ?? 0) <= now;
}

export function queuedEvent(event, now = Date.now(), options = {}) {
  if (!event?.id || !event?.createdAt) throw new Error("signed event id and createdAt are required");
  return {
    event,
    eventId: event.id,
    state: OUTBOX_STATES.queued,
    delivery: options.delivery || "normal",
    queuedAt: now,
    attempts: 0,
    nextAttemptAt: now,
    lastError: null
  };
}

export function shouldFlush(entries, policy = DEFAULT_OUTBOX_POLICY, now = Date.now()) {
  const ready = entries.filter((entry) => eligible(entry, now));
  if (ready.length === 0) return false;
  if (ready.some((entry) => entry.delivery === "immediate")) return true;
  if (ready.length >= policy.maxBatchEvents) return true;
  const bytes = ready.reduce((sum, entry) => sum + eventBytes(entry.event), 0);
  if (bytes >= policy.maxBatchBytes) return true;
  return now - Math.min(...ready.map((entry) => entry.queuedAt)) >= policy.flushAfterMs;
}

export function planFlush(entries, policy = DEFAULT_OUTBOX_POLICY, now = Date.now()) {
  const candidates = entries
    .filter((entry) => eligible(entry, now))
    .sort((left, right) => left.queuedAt - right.queuedAt || left.eventId.localeCompare(right.eventId));

  const selected = [];
  let bytes = 0;
  for (const entry of candidates) {
    const size = eventBytes(entry.event);
    if (selected.length >= policy.maxBatchEvents) break;
    if (selected.length > 0 && bytes + size > policy.maxBatchBytes) break;
    if (size > policy.maxBatchBytes) throw new Error(`event exceeds outbox batch limit: ${entry.eventId}`);
    selected.push(entry);
    bytes += size;
  }

  return {
    eventIds: selected.map((entry) => entry.eventId),
    events: selected.map((entry) => entry.event),
    bytes
  };
}

export function markSending(entries, eventIds, now = Date.now()) {
  const selected = new Set(eventIds);
  return entries.map((entry) => selected.has(entry.eventId)
    ? {
        ...entry,
        state: OUTBOX_STATES.sending,
        attempts: entry.attempts + 1,
        lastAttemptAt: now,
        sendingSince: now,
        splitRequired: false
      }
    : entry);
}

export function recoverSending(entries, policy = DEFAULT_OUTBOX_POLICY, now = Date.now()) {
  return entries.map((entry) => {
    if (entry.state !== OUTBOX_STATES.sending) return entry;
    const started = Number(entry.sendingSince ?? entry.lastAttemptAt ?? 0);
    if (started > 0 && now - started < policy.sendingLeaseMs) return entry;
    return {
      ...entry,
      state: OUTBOX_STATES.queued,
      nextAttemptAt: now,
      lastError: "sending_lease_expired",
      sendingSince: null
    };
  });
}

export function acknowledge(entries, eventIds, receipt = null, now = Date.now()) {
  const accepted = new Set(eventIds);
  return entries.map((entry) => accepted.has(entry.eventId)
    ? {
        ...entry,
        state: OUTBOX_STATES.committed,
        committedAt: now,
        receipt,
        lastError: null,
        sendingSince: null,
        splitRequired: false
      }
    : entry);
}

export function retryDelay(attempts, policy = DEFAULT_OUTBOX_POLICY, random = Math.random) {
  const base = Math.min(policy.maxRetryMs, policy.baseRetryMs * (2 ** Math.max(0, attempts - 1)));
  const ratio = Math.max(0, Math.min(1, Number(policy.jitterRatio ?? 0.2)));
  const sample = Math.max(0, Math.min(1, Number(random())));
  return Math.max(0, Math.round(base * (1 + ((sample * 2) - 1) * ratio)));
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(String(value));
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
}

export function classifyOutboxFailure(error, batchSize = 1) {
  const status = Number(error?.status || 0);
  const code = error?.code || (status ? `http_${status}` : "network_error");

  if (status === 401) return { state: OUTBOX_STATES.blockedAuth, code };
  if (status === 403) return { state: OUTBOX_STATES.blockedPermission, code };
  if (status === 404 || status === 405) return { state: OUTBOX_STATES.blockedConfiguration, code };
  if (status === 409) return { state: OUTBOX_STATES.rejectedConflict, code };
  if (status === 413 && batchSize > 1) return { state: OUTBOX_STATES.queued, code, splitRequired: true };
  if (status === 413) return { state: OUTBOX_STATES.rejectedTooLarge, code };
  if (status === 400 || status === 422 || (status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429)) {
    return { state: OUTBOX_STATES.rejectedInvalid, code };
  }
  return { state: OUTBOX_STATES.retryWait, code, retry: true };
}

export function rejectOrRetry(
  entries,
  eventIds,
  error,
  policy = DEFAULT_OUTBOX_POLICY,
  now = Date.now(),
  random = Math.random
) {
  const selected = new Set(eventIds);
  const outcome = classifyOutboxFailure(error, eventIds.length);
  const serverDelay = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : null;

  return entries.map((entry) => {
    if (!selected.has(entry.eventId)) return entry;

    if (outcome.splitRequired) {
      return {
        ...entry,
        state: OUTBOX_STATES.queued,
        nextAttemptAt: now,
        lastError: outcome.code,
        sendingSince: null,
        splitRequired: true
      };
    }

    if (outcome.retry) {
      return {
        ...entry,
        state: OUTBOX_STATES.retryWait,
        nextAttemptAt: now + (serverDelay ?? retryDelay(entry.attempts, policy, random)),
        lastError: outcome.code,
        sendingSince: null,
        splitRequired: false
      };
    }

    if (BLOCKED_STATES.has(outcome.state)) {
      return {
        ...entry,
        state: outcome.state,
        nextAttemptAt: null,
        blockedAt: now,
        lastError: outcome.code,
        sendingSince: null,
        splitRequired: false
      };
    }

    return {
      ...entry,
      state: outcome.state,
      rejectedAt: now,
      nextAttemptAt: null,
      lastError: outcome.code,
      sendingSince: null,
      splitRequired: false
    };
  });
}

export function unblock(entries, states = BLOCKED_STATES, now = Date.now()) {
  const selected = states instanceof Set ? states : new Set(states);
  return entries.map((entry) => selected.has(entry.state)
    ? {
        ...entry,
        state: OUTBOX_STATES.queued,
        nextAttemptAt: now,
        blockedAt: null,
        lastError: null
      }
    : entry);
}

export function pendingEntries(entries) {
  return entries.filter((entry) => !TERMINAL_STATES.has(entry.state));
}
