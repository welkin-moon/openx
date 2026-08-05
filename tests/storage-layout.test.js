import test from "node:test";
import assert from "node:assert/strict";
import {
  batchObjectPath,
  eventObjectPath,
  mediaObjectPath,
  segmentCatalogEntry,
  shouldSealSegment
} from "../packages/storage-layout/index.js";

const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("storage paths are date and hash sharded", () => {
  assert.equal(
    eventObjectPath(`sha256:${hash}`, "2026-08-05T09:10:11Z"),
    `events/live/2026/08/05/01/23/${hash}.json`
  );
  assert.equal(
    batchObjectPath(hash, "2026-08-05T09:10:11Z"),
    `events/live/2026/08/05/01/23/batch-${hash}.ndjson`
  );
  assert.equal(mediaObjectPath(hash), `media/01/23/${hash}.bin`);
});

test("segment sealing reports every reached threshold", () => {
  const result = shouldSealSegment({
    createdAt: "2026-01-01T00:00:00Z",
    reachableBytes: 600,
    objectCount: 20,
    commitCount: 30
  }, {
    maxAgeDays: 1,
    maxReachableBytes: 500,
    maxObjects: 10,
    maxCommits: 25
  }, Date.parse("2026-01-03T00:00:00Z"));

  assert.deepEqual(result, { seal: true, reasons: ["age", "size", "objects", "commits"] });
});

test("segment catalog is provider-neutral", () => {
  assert.deepEqual(segmentCatalogEntry({
    generation: 4,
    repository: "alice/openx-data-0004",
    ref: "main",
    createdAt: "2026-08-05T00:00:00Z"
  }), {
    version: "openx-storage-segment/1",
    generation: 4,
    state: "active",
    repository: "alice/openx-data-0004",
    ref: "main",
    createdAt: "2026-08-05T00:00:00Z",
    sealedAt: null,
    rootCommit: null,
    packs: [],
    objectCount: 0,
    reachableBytes: 0
  });
});
