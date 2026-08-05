const encoder = new TextEncoder();

export const DEFAULT_OUTBOX_POLICY = Object.freeze({
  flushAfterMs: 15_000,
  maxBatchEvents: 100,
  maxBatchBytes: 4_000_000,
  baseRetryMs: 1_000,
  maxRetryMs: 15 * 60_000,
  sendingLeaseMs: 60_000
});

function eventBytes(event) {
  return encoder.encode(`${JSON.stringify(event)}\n`).byteLength;
}

export function queuedEvent(event, now = Date.now()) {
  if (!event?.id || !event?.createdAt) throw new Error("signed event id and createdAt are required");
  return {
    event,
    eventId: event.id,
    state: "queued",
    queuedAt: now,
    attempts: 0,
    nextAttemptAt: now,
    lastError: null
  };
}

export function shouldFlush(entries, policy = DEFAULT_OUTBOX_POLICY, now = Date.now()) {
  const ready = entries.filter((entry) => entry.state === "queued" && entry.nextAttemptAt <= now);
  if (ready.length === 0) return false;
  if (ready.length >= policy.maxBatchEvents) return true;
  const bytes = ready.reduce((sum, entry) => sum + eventBytes(entry.event), 0);
  if (bytes >= policy.maxBatchBytes) return true;
  return now - Math.min(...ready.map((entry) => entry.queuedAt)) >= policy.flushAfterMs;
}

export function planFlush(entries, policy = DEFAULT_OUTBOX_POLICY, now = Date.now()) {
  const candidates = entries
    .filter((entry) => entry.state === "queued" && entry.nextAttemptAt <= now)
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
        state: "sending",
        attempts: entry.attempts + 1,
        lastAttemptAt: now,
        sendingSince: now
      }
    : entry);
}

export function recoverSending(entries, policy = DEFAULT_OUTBOX_POLICY, now = Date.now()) {
  return entries.map((entry) => {
    if (entry.state !== "sending") return entry;
    const started = Number(entry.sendingSince ?? entry.lastAttemptAt ?? 0);
    if (started > 0 && now - started < policy.sendingLeaseMs) return entry;
    return {
      ...entry,
      state: "queued",
      nextAttemptAt: now,
      lastError: "sending_lease_expired"
    };
  });
}

export function acknowledge(entries, eventIds, receipt = null, now = Date.now()) {
  const accepted = new Set(eventIds);
  return entries.map((entry) => accepted.has(entry.eventId)
    ? {
        ...entry,
        state: "committed",
        committedAt: now,
        receipt,
        lastError: null,
        sendingSince: null
      }
    : entry);
}

export function retryDelay(attempts, policy = DEFAULT_OUTBOX_POLICY) {
  return Math.min(policy.maxRetryMs, policy.baseRetryMs * (2 ** Math.max(0, attempts - 1)));
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(String(value));
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
}

export function rejectOrRetry(entries, eventIds, error, policy = DEFAULT_OUTBOX_POLICY, now = Date.now()) {
  const selected = new Set(eventIds);
  const status = Number(error?.status || 0);
  const permanent = status === 400 || status === 401 || status === 403 || status === 409 || status === 413 || status === 422;
  const serverDelay = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : null;

  return entries.map((entry) => {
    if (!selected.has(entry.eventId)) return entry;
    if (permanent) {
      return {
        ...entry,
        state: "rejected",
        rejectedAt: now,
        lastError: error?.code || `http_${status}`,
        sendingSince: null
      };
    }
    return {
      ...entry,
      state: "queued",
      nextAttemptAt: now + (serverDelay ?? retryDelay(entry.attempts, policy)),
      lastError: error?.code || (status ? `http_${status}` : "network_error"),
      sendingSince: null
    };
  });
}

export function pendingEntries(entries) {
  return entries.filter((entry) => entry.state === "queued" || entry.state === "sending");
}
