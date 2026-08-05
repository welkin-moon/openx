# OpenX architecture

## Trust and storage boundaries

### User node

The user node is the authority for the user's signed events and encrypted media. It writes ciphertext objects to the user's GitHub repository and exposes a manifest for future clients. Normal reading should use GitHub/Pages directly rather than the Worker.

### Relay

A relay is deliberately lightweight. It stores only:

- object announcements and source pointers;
- tag edges;
- reply and reaction edges;
- trustworthy-interaction views;
- attestations, certifications and value labels;
- withdrawal or invalidation metadata.

It must not store post bodies, comment bodies, media bytes, decryption keys or private preference models.

### Strong circle

A strong circle is a governed secondary broadcaster. It stores submissions, admissions, moderation and governance events. The original object remains at the author's node. A circle decision changes only that circle's view.

## Event lifecycle

1. A client encrypts content and media locally.
2. The client constructs and signs an `openx-event/1` envelope.
3. The user node verifies the event and writes it to GitHub.
4. A scheduled archiver will later compact inbox objects into journal segments.
5. The user node announces only public metadata and pointers to selected relays.
6. Clients fetch relay indexes, then fetch ciphertext from the author node and decrypt locally.

## Compatibility contract

Every service exposes `/openx/v1/manifest`. Clients must feature-detect capabilities and ignore unknown fields. Protocol additions should remain forward-compatible.

## Pending work

- GitHub Discussions adapter for immediate posts/comments;
- scheduled journal compaction and relay batch delivery;
- one-click setup Wizard and GitHub App authorization;
- encrypted media manifests and automatic media-repository rollover;
- device delegation, key rotation and account recovery;
- multisignature circle governance;
- conformance test vectors and Web/PWA client.
