# Cloudflare deployment

OpenX currently maps cleanly to Cloudflare Workers:

- `apps/node-worker`: Worker; Git remains the durable application data store.
- `apps/relay-worker`: Worker + Workers KV (`INDEX`).
- `apps/circle-worker`: Worker + Workers KV (`STATE`) for the current implementation.
- Future static/PWA client: Workers Static Assets or Pages, depending on the release/update flow.
- Future supervisor/bootstrap service: a separate Worker with narrowly scoped Cloudflare deployment credentials.

The Circle implementation currently uses the KV API directly. If governance state later requires strong transactional coordination, migrate that storage boundary to a SQLite-backed Durable Object rather than relying on eventually consistent Workers KV.

## Install

```bash
npm install
```

Wrangler is pinned as a project development dependency so local and CI deployments use the same major release.

## Local development

Create `.dev.vars` files next to each Wrangler config. Do not commit them.

`apps/node-worker/.dev.vars`:

```dotenv
NODE_DID="did:web:node.example.com"
NODE_API_TOKEN="replace-me"
NODE_ADMIN_TOKEN="replace-me"
GIT_OWNER="your-github-user"
GIT_REPOSITORY="your-openx-data-repo"
GIT_TOKEN="replace-me"
```

`apps/relay-worker/.dev.vars`:

```dotenv
RELAY_DID="did:web:relay.example.com"
RELAY_API_TOKEN="replace-me"
```

`apps/circle-worker/.dev.vars`:

```dotenv
CIRCLE_DID="did:web:circle.example.com"
CIRCLE_API_TOKEN="replace-me"
```

Run one service at a time:

```bash
npm run cf:dev:node
npm run cf:dev:relay
npm run cf:dev:circle
```

Wrangler can automatically provision the KV namespaces referenced by the Relay and Circle configs when no namespace ID is present.

## Production secrets

Before the first version upload, configure the required secrets for each Worker. For example:

```bash
npx wrangler secret put NODE_DID --config apps/node-worker/wrangler.jsonc
npx wrangler secret put NODE_API_TOKEN --config apps/node-worker/wrangler.jsonc
npx wrangler secret put NODE_ADMIN_TOKEN --config apps/node-worker/wrangler.jsonc
npx wrangler secret put GIT_OWNER --config apps/node-worker/wrangler.jsonc
npx wrangler secret put GIT_REPOSITORY --config apps/node-worker/wrangler.jsonc
npx wrangler secret put GIT_TOKEN --config apps/node-worker/wrangler.jsonc

npx wrangler secret put RELAY_DID --config apps/relay-worker/wrangler.jsonc
npx wrangler secret put RELAY_API_TOKEN --config apps/relay-worker/wrangler.jsonc

npx wrangler secret put CIRCLE_DID --config apps/circle-worker/wrangler.jsonc
npx wrangler secret put CIRCLE_API_TOKEN --config apps/circle-worker/wrangler.jsonc
```

For CI, prefer a scoped Cloudflare API token and provide Worker runtime secrets through your CI secret manager or Wrangler's `--secrets-file` support rather than committing them.

## Safe release workflow

Upload versions without activating them:

```bash
npm run cf:upload:node
npm run cf:upload:relay
npm run cf:upload:circle
```

Each upload can be smoke-tested through its version preview URL. Promote only after `/healthz` and `/openx/v1/manifest` pass:

```bash
npx wrangler versions deploy --config apps/node-worker/wrangler.jsonc
npx wrangler versions deploy --config apps/relay-worker/wrangler.jsonc
npx wrangler versions deploy --config apps/circle-worker/wrangler.jsonc
```

This matches OpenX's documented update model: create an immutable Worker Version, smoke-test it, then create a Deployment. Storage contents in KV/Git are not versioned with Worker code, so schema/storage migrations must remain independently rollback-safe.
