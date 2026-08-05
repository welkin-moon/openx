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
    this.eventIds = [];
    this.acceptedEventIds = [];
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

export async function postEventBatchWithSplit(
  endpoint,
  token,
  events,
  fetchImpl = fetch,
  now = Date.now()
) {
  try {
    const result = await postEventBatch(endpoint, token, events, fetchImpl, now);
    return {
      eventIds: Array.isArray(result?.eventIds) ? result.eventIds : events.map((event) => event.id),
      responses: [result]
    };
  } catch (error) {
    if (error?.status !== 413 || events.length <= 1) {
      error.eventIds = events.map((event) => event.id);
      throw error;
    }

    const middle = Math.ceil(events.length / 2);
    const leftEvents = events.slice(0, middle);
    const rightEvents = events.slice(middle);
    const left = await postEventBatchWithSplit(endpoint, token, leftEvents, fetchImpl, now);

    try {
      const right = await postEventBatchWithSplit(endpoint, token, rightEvents, fetchImpl, now);
      return {
        eventIds: [...left.eventIds, ...right.eventIds],
        responses: [...left.responses, ...right.responses]
      };
    } catch (rightError) {
      rightError.acceptedEventIds = [
        ...(rightError.acceptedEventIds || []),
        ...left.eventIds
      ];
      throw rightError;
    }
  }
}

export async function flushOutbox(entries, config, now = Date.now()) {
  const plan = planFlush(entries, config.policy, now);
  if (plan.events.length === 0) return { entries, result: null };

  const sending = markSending(entries, plan.eventIds, now);
  try {
    const result = await postEventBatchWithSplit(
      config.endpoint,
      config.token,
      plan.events,
      config.fetchImpl || fetch,
      now
    );
    const receipt = result.responses.length === 1
      ? result.responses[0]
      : { split: true, responses: result.responses };
    return {
      entries: acknowledge(sending, result.eventIds, receipt, now),
      result: receipt
    };
  } catch (error) {
    const accepted = new Set(error?.acceptedEventIds || []);
    const failedIds = Array.isArray(error?.eventIds) && error.eventIds.length > 0
      ? error.eventIds
      : plan.eventIds.filter((eventId) => !accepted.has(eventId));
    const partiallyAcknowledged = acknowledge(sending, [...accepted], {
      split: true,
      partial: true
    }, now);
    return {
      entries: rejectOrRetry(
        partiallyAcknowledged,
        failedIds,
        error,
        config.policy,
        now,
        config.random || Math.random
      ),
      error
    };
  }
}
