import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, eventId, relayRecord } from "../packages/protocol/index.js";

test("canonicalize sorts object keys recursively", () => {
  assert.equal(canonicalize({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test("event ids are stable", async () => {
  const event = { version: "openx-event/1", actor: "did:key:test", kind: "post.declare", createdAt: "2026-08-05T00:00:00Z", payload: { object: "sha256:abc", tags: ["test"] } };
  assert.equal(await eventId(event), await eventId(JSON.parse(JSON.stringify(event))));
});

test("relay records never include content bodies", () => {
  const record = relayRecord({ id: "sha256:event", actor: "did:key:test", kind: "post.declare", createdAt: "2026-08-05T00:00:00Z", payload: { object: "sha256:object", tags: ["openx"], ciphertext: "secret" } }, "https://example.invalid/object");
  assert.equal(record.object, "sha256:object");
  assert.equal("ciphertext" in record, false);
});
