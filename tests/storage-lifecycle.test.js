import test from "node:test";
import assert from "node:assert/strict";
import { storageCatalog } from "../packages/storage-layout/index.js";
import { catalogWriteSet, planSegmentRotation } from "../packages/storage-lifecycle/index.js";

function catalog() {
  return storageCatalog({
    actor: "did:key:test",
    updatedAt: "2026-08-01T00:00:00Z",
    segments: [{
      generation: "0001",
      state: "active",
      provider: "github",
      repository: "alice/openx-data-0001",
      ref: "main",
      createdAt: "2026-08-01T00:00:00Z",
      objectCount: 10,
      reachableBytes: 1000
    }]
  });
}

test("rotation planner keeps catalog unchanged below thresholds", () => {
  const current = catalog();
  const plan = planSegmentRotation({
    catalog: current,
    stats: { objectCount: 20, reachableBytes: 2000, commitCount: 20 },
    policy: { maxAgeDays: 30, maxReachableBytes: 10000, maxObjects: 100, maxCommits: 100 }
  }, "2026-08-02T00:00:00Z");

  assert.equal(plan.rotate, false);
  assert.equal(plan.catalog, current);
});

test("rotation planner seals active segment and creates next generation", () => {
  const plan = planSegmentRotation({
    catalog: catalog(),
    stats: { objectCount: 100, reachableBytes: 5000, commitCount: 101 },
    policy: { maxAgeDays: 30, maxReachableBytes: 10000, maxObjects: 100, maxCommits: 100 },
    rootCommit: "sealed-root",
    packs: [{ path: "packs/0001.ndjson.zst", sha256: "abc" }],
    nextRepository: "alice/openx-data-0002"
  }, "2026-08-05T10:00:00Z");

  assert.equal(plan.rotate, true);
  assert.deepEqual(plan.reasons.sort(), ["commits", "objects"]);
  assert.equal(plan.catalog.activeGeneration, "0002");
  assert.equal(plan.catalog.segments[0].state, "sealed");
  assert.equal(plan.catalog.segments[0].rootCommit, "sealed-root");
  assert.equal(plan.catalog.segments[1].repository, "alice/openx-data-0002");
});

test("catalog write set updates current catalog and appends immutable history", () => {
  const plan = planSegmentRotation({
    catalog: catalog(),
    stats: { objectCount: 101, reachableBytes: 5000, commitCount: 20 },
    policy: { maxAgeDays: 30, maxReachableBytes: 10000, maxObjects: 100, maxCommits: 100 }
  }, "2026-08-05T10:00:00Z");

  const writes = catalogWriteSet(plan);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, "openx/storage/catalog.json");
  assert.match(writes[1].path, /^openx\/storage\/history\//u);
  assert.equal(writes[0].bytes, writes[1].bytes);
});
