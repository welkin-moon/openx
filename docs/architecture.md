# OpenX architecture

## Trust and storage boundaries

### User node

The user node is the authority for the user's signed events and encrypted media. It writes ciphertext objects directly to a user-owned Git repository and exposes a manifest for future clients. Normal reading should use the user's static Git/Pages projection rather than the Worker.

The user node has no durable message buffer in the posting path. A successful response means the immutable event object or batch has already been committed to the configured Git provider.

### Relay

A relay is deliberately lightweight. It stores only:

- object announcements and source pointers;
- tag edges;
- reply, reaction and follow edges;
- trustworthy-interaction views;
- attestations, certifications and value labels;
- withdrawal or invalidation metadata.

It must not store post bodies, comment bodies, media bytes, decryption keys or private preference models.

### Strong circle

A strong circle is a governed secondary broadcaster. It stores submissions, admissions, moderation and governance events. The original object remains at the author's node. A circle decision changes only that circle's view.

## Direct Git write model

Git is both the canonical event log and the durable write-ahead store.

### Single-event write

1. A client encrypts content and media locally.
2. The client constructs and signs an `openx-event/1` envelope.
3. The user node verifies the signature and content-derived event ID.
4. The node writes the event to an immutable content-addressed path under `events/inbox/`.
5. Only after the Git provider returns a commit does the node report success.

### Batch write

A client or MCP agent may submit several already-signed events in one request. The node verifies every event and writes one NDJSON object. The response includes the batch hash, commit, event IDs and source position for every event.

Batching is an API-call optimization, not a separate queue. Failed requests remain in the client retry journal until a Git commit is confirmed.

### Scheduled work

Scheduled jobs are outside the posting success path. They may:

- merge many inbox objects into immutable journal packs;
- generate static profile, feed and thread projections;
- announce public pointers and social edges to selected relays;
- rotate media repositories and rebuild indexes;
- remove compacted inbox objects after the journal checkpoint is verified.

If scheduled work stops, new posts remain durable and readable from their Git object locations; only compacted views and relay discovery become stale.

## Comments and interactions

Replies, reactions and follows are ordinary signed events owned by the actor. No GitHub Discussion or platform-specific issue/comment ID is part of their protocol identity.

A reply contains logical references such as `root`, `parent` and encrypted-object hash. Relays may publish the reply edge, while clients fetch the reply ciphertext from the reply author's node.

This avoids binding thread history to one forge's discussion system and keeps migration to GitLab, Forgejo, Gitea, Codeberg or generic Git possible.

## Compatibility contract

Every service exposes `/openx/v1/manifest`. Clients must feature-detect capabilities and ignore unknown fields. Current node manifests declare:

- `durableBuffer: false`;
- `canonicalLog: git-immutable-objects`;
- `discussionWorkspace: false`;
- client-owned retry state;
- single-event and NDJSON batch endpoints.

Protocol additions should remain forward-compatible.

## Pending work

- scheduled journal compaction and relay batch delivery;
- one-click supervisor setup and Cloudflare API-token authorization;
- GitHub OAuth/App or fine-grained-token data-repository authorization;
- signed official release bundles and direct Pages deployment;
- encrypted media manifests and automatic media-repository rollover;
- device delegation, key rotation and account recovery;
- multisignature circle governance;
- conformance test vectors and Web/PWA client.
