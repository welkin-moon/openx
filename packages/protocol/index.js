const enc = new TextEncoder();

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

export function canonicalize(value) {
  return JSON.stringify(sorted(value));
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? enc.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function eventId(unsigned) {
  return `sha256:${await sha256(canonicalize(unsigned))}`;
}

export function unsignedEvent(event) {
  const { id, signature, ...unsigned } = event;
  return unsigned;
}

export async function verifyEvent(event) {
  if (!event || event.version !== "openx-event/1") throw new Error("unsupported event version");
  if (!event.actor || !event.kind || !event.createdAt || !event.payload) throw new Error("incomplete event");
  const unsigned = unsignedEvent(event);
  const expected = await eventId(unsigned);
  if (expected !== event.id) throw new Error("event id mismatch");
  if (!event.signature?.publicKey || !event.signature?.value) throw new Error("missing signature");
  const key = await crypto.subtle.importKey("raw", fromBase64url(event.signature.publicKey), { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("Ed25519", key, fromBase64url(event.signature.value), enc.encode(canonicalize(unsigned)));
  if (!ok) throw new Error("invalid signature");
  return true;
}

export function relayRecord(event, source) {
  const base = { eventId: event.id, actor: event.actor, kind: event.kind, createdAt: event.createdAt, source };
  if (event.kind.startsWith("post.")) return { ...base, object: event.payload.object, tags: event.payload.tags ?? [], audience: event.payload.audience ?? "public" };
  if (event.kind.startsWith("reply.")) return { ...base, object: event.payload.object, root: event.payload.root, parent: event.payload.parent ?? null };
  if (event.kind.startsWith("reaction.")) return { ...base, target: event.payload.target, reaction: event.payload.reaction ?? "like" };
  if (event.kind.startsWith("follow.")) return { ...base, target: event.payload.target };
  if (event.kind.startsWith("attestation.") || event.kind.startsWith("label.")) return { ...base, target: event.payload.target, value: event.payload.value, issuer: event.actor };
  return null;
}

export const manifests = {
  node: "openx-node/1",
  relay: "openx-relay/1",
  circle: "openx-circle/1"
};
