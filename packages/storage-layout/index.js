const DEFAULT_MIB = 1024 * 1024;

export const DEFAULT_SEGMENT_POLICY = Object.freeze({
  maxAgeDays: 30,
  maxReachableBytes: 512 * DEFAULT_MIB,
  maxObjects: 50_000,
  maxCommits: 10_000
});

function stripHashPrefix(value) {
  const text = String(value);
  return text.startsWith("sha256:") ? text.slice(7) : text;
}

function assertHexHash(value) {
  const hash = stripHashPrefix(value);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("expected lowercase SHA-256");
  return hash;
}

function dateParts(createdAt) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(String(createdAt));
  return match ? match.slice(1, 4) : ["undated", "00", "00"];
}

export function eventObjectPath(eventId, createdAt) {
  const hash = assertHexHash(eventId);
  const [year, month, day] = dateParts(createdAt);
  return `events/live/${year}/${month}/${day}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.json`;
}

export function batchObjectPath(batchHash, createdAt) {
  const hash = assertHexHash(batchHash);
  const [year, month, day] = dateParts(createdAt);
  return `events/live/${year}/${month}/${day}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/batch-${hash}.ndjson`;
}

export function mediaObjectPath(hashValue) {
  const hash = assertHexHash(hashValue);
  return `media/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.bin`;
}

export function shouldSealSegment(stats, policy = DEFAULT_SEGMENT_POLICY, now = Date.now()) {
  const createdAt = new Date(stats.createdAt).getTime();
  const ageDays = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) / 86_400_000 : 0;

  const reasons = [];
  if (ageDays >= policy.maxAgeDays) reasons.push("age");
  if (Number(stats.reachableBytes || 0) >= policy.maxReachableBytes) reasons.push("size");
  if (Number(stats.objectCount || 0) >= policy.maxObjects) reasons.push("objects");
  if (Number(stats.commitCount || 0) >= policy.maxCommits) reasons.push("commits");

  return { seal: reasons.length > 0, reasons };
}

export function segmentCatalogEntry(input) {
  if (!input?.repository || !input?.ref || !input?.generation) {
    throw new Error("repository, ref and generation are required");
  }

  return {
    version: "openx-storage-segment/1",
    generation: input.generation,
    state: input.state || "active",
    repository: input.repository,
    ref: input.ref,
    provider: input.provider || "github",
    createdAt: input.createdAt,
    sealedAt: input.sealedAt || null,
    rootCommit: input.rootCommit || null,
    objectBase: input.objectBase || "",
    packs: input.packs || [],
    objectCount: Number(input.objectCount || 0),
    reachableBytes: Number(input.reachableBytes || 0)
  };
}

export function storageCatalog(input) {
  const segments = (input?.segments || []).map(segmentCatalogEntry);
  const active = segments.filter((segment) => segment.state === "active");
  if (active.length !== 1) throw new Error("storage catalog requires exactly one active segment");
  return {
    version: "openx-storage-catalog/1",
    actor: input.actor,
    updatedAt: input.updatedAt,
    activeGeneration: active[0].generation,
    segments
  };
}

export function defaultStorageCatalog(env, now = new Date().toISOString()) {
  const owner = env.GIT_OWNER || env.GITHUB_OWNER;
  const repository = env.GIT_REPOSITORY || env.GITHUB_REPO;
  const ref = env.GIT_BRANCH || env.GITHUB_BRANCH || "main";
  if (!owner || !repository) throw new Error("Git storage repository is not configured");
  return storageCatalog({
    actor: env.NODE_DID,
    updatedAt: now,
    segments: [{
      generation: env.STORAGE_GENERATION || "0001",
      state: "active",
      provider: env.GIT_PROVIDER || "github",
      repository: `${owner}/${repository}`,
      ref,
      createdAt: env.STORAGE_CREATED_AT || now,
      objectBase: env.STORAGE_OBJECT_BASE || ""
    }]
  });
}
