import {
  DEFAULT_SEGMENT_POLICY,
  segmentCatalogEntry,
  shouldSealSegment,
  storageCatalog
} from "../storage-layout/index.js";

function nextGeneration(value) {
  const width = Math.max(4, String(value || "0").length);
  const number = Number.parseInt(String(value || "0"), 10);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("segment generation must be a non-negative integer string");
  return String(number + 1).padStart(width, "0");
}

export function planSegmentRotation(input, now = new Date().toISOString()) {
  const catalog = input?.catalog;
  const stats = input?.stats || {};
  const policy = input?.policy || DEFAULT_SEGMENT_POLICY;
  if (catalog?.version !== "openx-storage-catalog/1") throw new Error("unsupported storage catalog");

  const active = catalog.segments.find((segment) => segment.generation === catalog.activeGeneration);
  if (!active || active.state !== "active") throw new Error("active storage segment is missing");

  const decision = shouldSealSegment({
    createdAt: active.createdAt,
    reachableBytes: stats.reachableBytes ?? active.reachableBytes,
    objectCount: stats.objectCount ?? active.objectCount,
    commitCount: stats.commitCount ?? 0
  }, policy, new Date(now).getTime());

  if (!decision.seal) {
    return {
      rotate: false,
      reasons: [],
      catalog
    };
  }

  const generation = nextGeneration(active.generation);
  const repository = input.nextRepository || active.repository;
  const ref = input.nextRef || active.ref;
  const next = segmentCatalogEntry({
    generation,
    state: "active",
    provider: input.nextProvider || active.provider,
    repository,
    ref,
    createdAt: now,
    objectBase: input.nextObjectBase || "",
    objectCount: 0,
    reachableBytes: 0
  });

  const segments = catalog.segments.map((segment) => segment.generation === active.generation
    ? segmentCatalogEntry({
        ...segment,
        state: "sealed",
        sealedAt: now,
        rootCommit: input.rootCommit || segment.rootCommit,
        packs: input.packs || segment.packs,
        objectCount: Number(stats.objectCount ?? segment.objectCount ?? 0),
        reachableBytes: Number(stats.reachableBytes ?? segment.reachableBytes ?? 0)
      })
    : segment);
  segments.push(next);

  return {
    rotate: true,
    reasons: decision.reasons,
    sealedGeneration: active.generation,
    activeGeneration: generation,
    catalog: storageCatalog({
      actor: catalog.actor,
      updatedAt: now,
      segments
    })
  };
}

export function catalogWriteSet(plan) {
  if (!plan?.rotate) return [];
  const json = `${JSON.stringify(plan.catalog, null, 2)}\n`;
  return [
    { path: "openx/storage/catalog.json", bytes: json },
    {
      path: `openx/storage/history/${plan.catalog.updatedAt.replaceAll(":", "-")}.json`,
      bytes: json
    }
  ];
}
