# OpenX

[简体中文](README.zh-CN.md) | **English**

OpenX is an AGPL-3.0-only, user-owned social-web foundation built around portable signed events, encrypted content objects, Git repositories and Cloudflare Workers.

The project currently defines three Web roles:

- **User node** — accepts signed ciphertext events and media, writes them directly into a user-owned Git repository, and later announces lightweight metadata to relays.
- **Relay** — distributes object pointers and maintains tag, trustworthy-interaction, certification and value-label indexes. It never stores post bodies, comment bodies, media bytes or decryption keys.
- **Strong circle** — maintains submissions, admissions, moderation and signed governance decisions while original content remains at author nodes.

A future Web/PWA/native client can discover all three roles through stable manifests and protocol contracts.

## Design decisions

### Git is the durable write-ahead log

OpenX does not require GitHub Discussions, D1, Queues or a separate message buffer for normal posting.

- A normal post or interaction is written immediately as one immutable signed event object.
- A client or MCP agent may submit several already-signed events as one NDJSON batch to reduce Git API calls.
- Failed writes remain the client's responsibility to retry.
- Scheduled jobs compact immutable inbox objects into larger journal packs and publish relay announcements; compaction is not part of the success path for posting.

### Relays stay lightweight

Relays contain pointers and judgments, not user content. They may publish:

- object announcements;
- tag edges;
- reply/reaction/follow edges;
- trustworthy-interaction views;
- attestations, certifications and value labels;
- withdrawal or invalidation records.

### Storage providers are replaceable

OpenX identities and object IDs are DIDs and hashes, never GitHub URLs. The `GitProvider` boundary currently implements GitHub and is intended to support GitLab, Forgejo/Gitea/Codeberg and generic Git-compatible storage later.

### No source fork is required for users

The intended installer deploys a small supervisor once. Later OpenX releases are installed from signed official release artifacts through Cloudflare's deployment APIs. User-owned Git repositories contain data, not a manually synchronized copy of OpenX source.

## Repository layout

```text
apps/
  node-worker/       user-owned node
  relay-worker/      lightweight discovery and trust relay
  circle-worker/     governed strong-circle index
packages/
  protocol/          canonical signed event format
  git-provider/      replaceable Git storage adapters
  worker-kit/        small Worker HTTP helpers
docs/
tests/
```

## Current HTTP surface

User node:

```text
GET  /openx/v1/manifest
POST /openx/v1/events
POST /openx/v1/events/batch
PUT  /openx/v1/media/{sha256}
```

The server accepts ciphertext and public metadata only. Encryption, signing and retry state belong to the client/MCP side.

## Status

This is an executable architecture scaffold, not a production release. Major unfinished work includes:

- one-time Cloudflare supervisor/bootstrap flow;
- GitHub OAuth/App or fine-grained-token setup for user data repositories;
- direct Pages deployment and signed upstream updates;
- scheduled Git journal compaction and relay delivery;
- encrypted media manifests and media-repository rollover;
- device delegation, recovery and audience-key rotation;
- multisignature circle governance;
- complete Web/PWA client and conformance vectors.

## Development

```bash
npm test
npm run check
```

## Documentation

- [Architecture](docs/architecture.md)
- [Bootstrap, credentials and updates](docs/bootstrap-and-updates.md)

## License

GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).
