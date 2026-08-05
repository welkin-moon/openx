import {
  acknowledge,
  markSending,
  parseRetryAfter,
  planFlush,
  rejectOrRetry
} from "./index.js";

export class OutboxHttpError extends Error {
  constructor(status, code, message, retryAfterMs = null) {
    super(message);
    this.name = "OutboxHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return { message: text }; }
}

export async function postEventBatch(endpoint, token, events, fetchImpl = fetch, now = Date.now()) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ events })
  });
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new OutboxHttpError(
      response.status,
      body?.error || `http_${response.status}`,
      body?.message || `OpenX node returned ${response.status}`,
      parseRetryAfter(response.headers.get("retry-after"), now)
    );
  }
  return body;
}

export async function flushOutbox(entries, config, now = Date.now()) {
  const plan = planFlush(entries, config.policy, now);
  if (plan.events.length === 0) return { entries, result: null };

  const sending = markSending(entries, plan.eventIds, now);
  try {
    const result = await postEventBatch(
      config.endpoint,
      config.token,
      plan.events,
      config.fetchImpl || fetch,
      now
    );
    const acknowledged = Array.isArray(result?.eventIds) ? result.eventIds : plan.eventIds;
    return {
      entries: acknowledge(sending, acknowledged, result, now),
      result
    };
  } catch (error) {
    return {
      entries: rejectOrRetry(sending, plan.eventIds, error, config.policy, now),
      error
    };
  }
}
