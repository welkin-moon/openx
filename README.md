# OpenX

OpenX is an AGPL-3.0-only user-owned social web foundation built around GitHub repositories and Cloudflare Workers.

The first milestone focuses on three Web services:

- **User node**: accepts signed ciphertext objects, writes posts/interactions/media to the user's GitHub repository, and periodically announces metadata.
- **Relay**: distributes object pointers and maintains only lightweight tag, trust, certification and value-label indexes. It never caches post bodies or media.
- **Strong circle**: maintains submissions, admissions and signed governance decisions while original objects remain on author nodes.

A future Web/PWA/native client can discover all three roles through stable manifests and API contracts in `packages/protocol`.

## Layout

```text
apps/
  node-worker/
  relay-worker/
  circle-worker/
packages/
  protocol/
  worker-kit/
docs/
```

## Current status

This is an executable architecture scaffold, not a production release. It establishes service boundaries and compatibility contracts before implementing the full GitHub Discussions adapter, one-click bootstrap, encryption UI and client.

## Development

```bash
npm test
npm run check
```

## License

GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).
