# Transport and synchronization

## Principle

Normal clients MUST NOT clone or fetch an OpenX data repository.

Git is the durable authority and migration format, not the normal application
transport. Web, PWA, native clients, AI agents and relays consume HTTP objects,
manifests and cursor indexes.

`.gitignore` only controls which untracked local files are considered for
commits. It does not hide tracked files from clones, reduce remote repository
history, or provide an application synchronization protocol.

## Read paths

A user node publishes static or cacheable HTTP resources:

```text
/openx/v1/manifest
/openx/v1/head.json
/openx/v1/index/{segment}.ndjson
/openx/v1/objects/{sha256}
/openx/v1/media/{sha256}
```

The manifest advertises one or more locations for each resource class. A
location may point to Cloudflare Pages, a Git provider raw-object endpoint, an
HTTP mirror, or a future compatible storage provider.

Clients follow this algorithm:

1. Fetch the small node manifest with conditional HTTP headers.
2. Fetch `head.json` using `If-None-Match` or `If-Modified-Since`.
3. If the cursor changed, fetch only index segments newer than the local cursor.
4. Resolve only the object hashes required for the visible feed or thread.
5. Verify object hashes and signatures locally.
6. Persist cursors, object metadata and ciphertext in a bounded local cache.

Clients never enumerate the full repository tree during normal use.

## Index segments

Indexes are append-only NDJSON segments. Each record contains only enough data
to locate and order an immutable event/object:

```json
{
  "cursor": "2026-08-05T08:30:00Z/sha256:...",
  "eventId": "sha256:...",
  "kind": "post.declare",
  "actor": "did:key:...",
  "createdAt": "2026-08-05T08:30:00Z",
  "object": "sha256:...",
  "location": {
    "type": "http-object",
    "url": "https://example.invalid/openx/v1/objects/..."
  }
}
```

Segments are immutable and content-addressed. `head.json` is the only frequently
updated pointer. It contains the newest cursor, current segment list, active
repository generation and optional compact snapshot locations.

## Conditional requests and caching

Static responses should provide:

- strong `ETag` values derived from content hashes;
- immutable cache headers for content-addressed objects;
- short cache headers plus validation for `manifest` and `head.json`;
- byte-range support for large media and pack files where available.

A client should not refetch an object whose verified hash already exists in its
local cache.

## Write paths

Important events may be written immediately. High-frequency interactions use a
client-side persistent outbox and a default flush interval of approximately 15
seconds.

The outbox:

- stores already-signed immutable events;
- survives reloads and temporary loss of connectivity;
- sends one event or one NDJSON batch;
- retries with exponential backoff and jitter;
- deletes an entry only after receiving a durable Git commit/object location;
- treats an existing event ID as a successful idempotent write.

There is no mandatory D1, Queue, Discussion or server-side durable message
buffer in the success path.

## Repository maintenance

Repository maintenance is asynchronous and low frequency:

- create larger index/journal packs after an object-count or time threshold;
- publish new `head.json` pointers;
- rotate to a new repository generation before size or file-count limits become
  operationally expensive;
- keep old generations immutable and readable;
- garbage-collect only local caches and derived indexes, never signed source
  events without an explicit withdrawal policy.

Compaction improves transfer and migration performance. It is not required for
a new event to become valid.

## Administrative Git access

Full or partial Git operations are reserved for:

- backup and disaster recovery;
- provider migration;
- integrity audits;
- pack generation and repository maintenance;
- advanced self-hosted mirrors.

These tools should use shallow, sparse or partial clone techniques when the Git
provider supports them. Normal clients do not expose Git operations.
