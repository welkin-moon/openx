# Bootstrap, credentials and upstream updates

Status: architecture decision for the first public installer.

## Goals

- A user visits Cloudflare only once during initial installation.
- Users do not fork or manually synchronize the OpenX source repository.
- OpenX application code is released from the official repository as signed,
  immutable artifacts.
- User data remains in repositories owned by the user and can migrate to a
  different Git provider.
- The normal user-node runtime never receives broad Cloudflare management
  credentials.

## Two Worker roles

### Supervisor

A small, rarely changing Worker installed first. It owns only the deployment
control plane:

- bootstrap the user's Cloudflare resources;
- create a Direct Upload Pages project;
- upload and deploy signed user-node versions;
- deploy static Pages assets;
- run schema migrations and rollback failed releases;
- keep the restricted Cloudflare runtime token in a secret;
- expose setup, update and recovery endpoints.

The supervisor does not read social content, media plaintext or identity root
keys.

### User node

The actual OpenX service. It owns the social control plane:

- authorize clients and MCP agents;
- write encrypted events and media to a configured Git provider;
- compact journals and announce metadata to relays;
- expose the portable OpenX node manifest.

The user node does not receive Cloudflare deployment credentials.

## Cloudflare credential flow

Cloudflare API Tokens are used. The legacy Global API Key is not supported.

During setup, the user supplies one short-lived bootstrap token created from
Cloudflare's **Create additional tokens** template. The supervisor uses it to
mint a restricted account-owned `openx-runtime` token, then uses the runtime
token to:

1. create required Pages/KV/D1 resources;
2. upload the user-node Worker version and deploy it;
3. store the runtime token as a supervisor secret;
4. configure schedules and optional routes;
5. revoke the bootstrap token.

The runtime token is retained because unattended updates and Pages direct
uploads require Cloudflare API access. It should contain only the permissions
needed by the selected feature set, normally:

- Workers Scripts Write;
- Pages Write;
- KV/D1 write permissions only when those bindings are enabled;
- Zone/DNS/Routes permissions only when a custom domain is enabled.

Cloudflare currently scopes Workers script permissions at account level rather
than to one individual script. A dedicated Cloudflare account is therefore the
recommended high-isolation deployment mode.

## Official source and update channel

Workers Builds is not the update authority. CI in the official OpenX repository
produces deterministic release artifacts:

- `supervisor.mjs`;
- `node-worker.mjs`;
- static client/Pages asset pack;
- migration pack;
- signed `release-manifest.json`.

The release manifest includes artifact SHA-256 hashes, protocol/schema
compatibility, rollout channel and rollback metadata. It is signed by an
offline OpenX release key. The public verification key is pinned in the
supervisor.

Update flow:

1. supervisor fetches the release manifest from one or more configured mirrors;
2. verifies the release signature and artifact hashes;
3. checks schema compatibility;
4. uploads a new Worker Version without deploying it;
5. runs a health check against the preview version;
6. creates a deployment if checks pass;
7. directly uploads the new Pages assets;
8. records the active release and previous rollback version.

A user can select stable, beta, pinned or manual-approval update policy. No
source fork is involved.

## Initial deployment limitation

Cloudflare's public-repository deploy flow currently clones the source into a
repository under the deployer's GitHub/GitLab account. It does not provide a
portable mechanism for every user Worker to subscribe directly to a third-party
repository as a shared build source.

OpenX therefore treats the initial Cloudflare deployment only as a bootstrap
transport. A generated clone, when Cloudflare creates one, is not an upstream
source and may be ignored after setup. All later releases are installed by the
supervisor from signed official artifacts through the Workers Versions API.

A future hosted installer may instead deploy a temporary Worker account and let
the user claim it, but permanent unattended updates would still require an
explicit Cloudflare authorization flow.

## GitHub authorization is for data, not application code

The GitHub credential never controls OpenX software updates. It only grants the
user node access to user-owned data/media repositories and an optional GitHub
Discussions workspace.

Supported authorization modes:

1. **Fine-grained personal access token**: simplest first implementation. The
   token is limited to selected OpenX repositories with Contents and
   Discussions write permissions and is stored as a Worker secret.
2. **User-owned GitHub App**: preferred advanced mode. The setup flow creates an
   app owned by the user, installs it only on their OpenX repositories, stores
   the private key in the user node and generates one-hour installation tokens
   as needed.
3. **Official GitHub App with device flow**: possible convenience mode, but it
   introduces dependency on an OpenX-owned app registration and is not the
   decentralized default.

A GitHub App is an API identity installed on repositories. It is unrelated to
Cloudflare's Git repository connection and does not require the user to fork
OpenX source code.

## Provider portability

OpenX IDs are hashes/DIDs, never GitHub URLs or issue/discussion IDs. Git
locations and discussion projections are replaceable records.

The storage adapter boundary must support at least:

- GitHub;
- GitLab;
- Forgejo/Gitea/Codeberg;
- generic HTTP Git plus a journal-only interaction workspace.

Migration copies ciphertext and journals, verifies hashes, publishes new
location declarations, temporarily dual-writes, and finally cuts over. Relays
only update object pointers; identities, post IDs, reply IDs and follows do not
change.
