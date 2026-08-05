# Bootstrap, credentials and upstream updates

Status: architecture decision for the first public installer.

## Goals

- A user visits Cloudflare only once during initial installation.
- Users do not fork or manually synchronize the OpenX source repository.
- OpenX application code is released from the official repository as signed, immutable artifacts.
- User posts, replies, interactions and media are written directly to user-owned Git repositories.
- No GitHub Discussions, D1 queue or durable message buffer is required for normal posting.
- User data can migrate to a different Git provider without changing OpenX identities or object IDs.
- The normal user-node runtime never receives broad Cloudflare management credentials.

## Two Worker roles

### Supervisor

A small, rarely changing Worker installed first. It owns only the deployment control plane:

- bootstrap the user's Cloudflare resources;
- create a Direct Upload Pages project;
- upload and deploy signed user-node versions;
- deploy static Pages assets;
- run schema migrations and rollback failed releases;
- keep a restricted Cloudflare runtime token in a secret;
- expose setup, update and recovery endpoints.

The supervisor does not read social ciphertext, media plaintext, Git data credentials or identity root keys.

### User node

The actual OpenX service. It owns the social control plane:

- authorize clients and MCP agents;
- verify signed encrypted events;
- write events and media directly to a configured Git provider;
- compact immutable Git objects into journal packs;
- announce lightweight metadata to relays;
- expose the portable OpenX node manifest.

The user node does not receive Cloudflare deployment credentials.

## Cloudflare credential flow

Cloudflare API Tokens are used. The legacy Global API Key is not supported.

During setup, the user supplies one short-lived token created from Cloudflare's **Create additional tokens** template. That template grants the user-level API Tokens Write permission and is specifically required for creating subsequent API tokens through the API.

The supervisor uses the bootstrap token to create a restricted account-owned `openx-runtime` token. The runtime token is then used to:

1. create the Direct Upload Pages project and optional KV/D1 resources;
2. upload the user-node Worker version and create its deployment;
3. configure schedules and optional routes;
4. update Worker and Pages releases unattended;
5. preserve rollback access.

After verifying the runtime token, the supervisor revokes the bootstrap token. Cloudflare recommends that the Create additional tokens credential contain no unrelated permissions because it can create tokens with access to the user's resources.

The runtime token is retained as a supervisor secret because unattended Worker-version uploads and Pages Direct Upload deployments require Cloudflare API access. It should contain only the permissions needed by the selected feature set:

- Workers Scripts Write;
- Pages Write;
- KV/D1 write only when those optional bindings are enabled;
- Zone/DNS/Workers Routes only when a custom domain is enabled.

Cloudflare Workers script write permissions are account-scoped rather than restricted to one individual Worker script. A dedicated Cloudflare account remains the recommended high-isolation mode.

## Official source and update channel

Workers Builds is not the update authority. Cloudflare's Deploy to Cloudflare button clones a public repository into a repository owned by the deploying user. OpenX may use this as the initial bootstrap transport, but the clone is not an upstream and does not need to be maintained.

CI in the official OpenX repository produces deterministic release artifacts:

- `supervisor.mjs`;
- `node-worker.mjs`;
- static client/Pages asset tree;
- migration pack;
- signed `release-manifest.json`.

The release manifest includes artifact SHA-256 hashes, protocol/schema compatibility, rollout channel and rollback metadata. It is signed by an offline OpenX release key. The public verification key is pinned in the supervisor.

Update flow:

1. fetch the manifest from one or more configured mirrors;
2. verify the release signature and artifact hashes;
3. check schema compatibility;
4. upload a new Worker Version without activating it;
5. smoke-test the preview version;
6. create a Worker Deployment if checks pass;
7. directly upload the new Pages assets;
8. record the active and previous rollback versions.

Cloudflare separates Worker Versions from Deployments, so upload, testing, promotion and rollback can be controlled independently. Pages Direct Upload accepts prebuilt assets without binding the Pages project to a Git repository.

A user can select stable, beta, pinned or manual-approval update policy. No source fork is involved in later upgrades.

## Direct Git write model

The configured Git repository is the durable write-ahead log.

- `POST /openx/v1/events` verifies one signed event and writes one immutable object before returning success.
- `POST /openx/v1/events/batch` verifies all events and writes one NDJSON object before returning success.
- Media chunks are written to content-addressed paths.
- Failed requests remain in the client/MCP retry journal.
- Scheduled compaction and relay announcements occur after the durable Git commit and are not required for posting success.

GitHub enforces both primary API limits and secondary content-creation limits. OpenX therefore supports event batching, bounded concurrency, exponential backoff and idempotent content-addressed paths. These controls are client/node retry behavior, not a separate persistent queue.

## GitHub authorization is for user data, not application code

The GitHub credential never controls OpenX software updates. It grants access only to user-owned OpenX data and media repositories.

### Default convenient mode: official OpenX GitHub App

The installer sends the user through GitHub App authorization and installation.

There are two token roles:

1. **GitHub App user access token** — acts on behalf of the user. During setup it can create the initial personal data/media repositories through `POST /user/repos`, subject to the app's permissions and the user's own rights.
2. **GitHub App installation access token** — operates on repositories where the app is installed. It is used for normal event/media writes and expires after about one hour, so the node creates new tokens as needed.

The app is installed only on the OpenX repositories selected by the user. Ongoing permissions need only repository metadata read and contents write. Discussions and Issues permissions are not required.

Using the official App introduces a convenience dependency on the official App registration, but not custody of user data: repositories stay in the user's GitHub account. Advanced modes remain available.

### Advanced authorization modes

- **User-owned GitHub App** — strongest independence; the user owns the app registration and private key.
- **Fine-grained personal access token** — simpler fallback limited to selected OpenX repositories with Contents write access.
- **Alternative Git provider adapter** — GitLab, Forgejo/Gitea/Codeberg or generic Git-compatible storage.

## Provider portability

OpenX IDs are hashes and DIDs, never GitHub URLs, repository IDs or discussion IDs. Git locations are replaceable records.

The storage adapter boundary must support at least:

- GitHub;
- GitLab;
- Forgejo/Gitea/Codeberg;
- generic HTTP Git with an immutable journal layout.

Migration:

1. bind the new provider;
2. copy ciphertext objects, media and journal packs;
3. verify every object hash;
4. publish new signed location declarations;
5. dual-write for a bounded transition period;
6. notify selected relays of the new node/location manifest;
7. cut over and make the old provider read-only or remove it.

Relays only update object pointers. Identities, post IDs, reply IDs, follows and signatures do not change.
