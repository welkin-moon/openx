# OpenX roadmap

This roadmap is intentionally iterative. Each round should end with executable
code, tests and documentation rather than architecture notes alone.

## Round 1 — reliable Git transport

Goal: make the user node a correct, low-request Git-backed event service.

- zero-clone HTTP read protocol and cursor/index format;
- persistent 15-second client outbox contract;
- idempotent single-event and batch writes;
- Git tree-based multi-object commits;
- conditional writes and conflict retries;
- content-addressed media manifests;
- request budgets, backoff and conformance tests.

Exit criteria:

- duplicate event submissions do not create duplicate logical events;
- a client can resume reads from a cursor without repository enumeration;
- a batch can atomically publish multiple immutable objects in one commit;
- tests cover rate-limit, conflict and retry behavior.

## Round 2 — bootstrap and signed updates

Goal: install once in Cloudflare and require no source fork or manual update.

- minimal supervisor Worker;
- one-time Cloudflare API Token bootstrap;
- restricted runtime-token creation and secret storage;
- signed official release manifests and artifact verification;
- Worker Versions deployment, health checks and rollback;
- Direct Upload Pages deployment;
- setup lockout and recovery flow.

Exit criteria:

- a fresh Cloudflare account can produce a running node and Pages site;
- an update can be installed and rolled back without visiting the dashboard;
- the user never needs to maintain an OpenX source fork.

## Round 3 — GitHub data authorization and provider migration

Goal: make GitHub convenient without making it part of identity or protocol.

- official GitHub App convenience flow;
- fine-grained PAT and user-owned App fallback modes;
- automatic data/media repository provisioning;
- GitLab and Forgejo/Gitea provider adapters;
- migration with hash verification, dual write and cutover;
- repository generation and media-repository rotation.

Exit criteria:

- GitHub can be replaced without changing DID, post IDs, reply IDs or follows;
- a complete encrypted node can migrate between two providers and verify every
  object hash.

## Round 4 — portable relay and strong-circle servers

Goal: support Cloudflare and user-owned VPS deployments using one protocol.

- Node/Bun HTTP server entrypoints;
- SQLite and PostgreSQL RelayStore adapters;
- cursor-based ingestion and idempotent batches;
- tag, interaction, certification and value-label indexes;
- strong-circle admission and signed governance storage;
- Docker/Compose packaging;
- realistic benchmark and capacity-report tooling.

Exit criteria:

- the same relay conformance suite passes on KV, SQLite and PostgreSQL;
- a 2-core reference VPS has published sustained-load results and operational
  limits.

## Round 5 — Web/PWA client and encrypted audiences

Goal: deliver a usable end-user product without introducing online key-service
requirements for ordinary reads.

- multilingual responsive Web/PWA client;
- local identity, signing and encrypted IndexedDB storage;
- persistent outbox and bounded ciphertext cache;
- feed merging from relays and followed node indexes;
- audience epoch-key distribution and device recovery;
- media upload, chunking, range reads and local decryption;
- accessibility and offline operation.

Exit criteria:

- a user can install, post, reply, follow and read from two devices;
- normal reading does not call a per-object key service or clone repositories.

## Round 6 — agents, MCP and operational hardening

Goal: safely support AI automation and public operation.

- delegated agent identities and granular scopes;
- MCP-compatible semantic operations;
- rate, budget and expiry policies;
- audit trails showing user, delegate and transport;
- relay abuse controls, reports and appeals;
- metrics, backups, repair tools and security review;
- protocol conformance vectors and release process.

Exit criteria:

- an AI agent can operate from a user-owned VPS without GitHub, Cloudflare or
  root identity credentials;
- compromised delegates can be revoked without rotating the identity root.

## Working rules

- Source events are immutable and signed; indexes and caches are rebuildable.
- Relays never become the source of post bodies or media.
- Git providers are storage locations, not identities.
- Normal clients never clone repositories.
- New infrastructure must be optional and replaceable.
- Every round updates both English and Simplified Chinese documentation where
  user-facing behavior changes.
