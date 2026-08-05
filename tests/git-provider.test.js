import test from "node:test";
import assert from "node:assert/strict";
import {
  GitHubProvider,
  GitConflictError,
  GitControlVersionConflictError,
  GitProviderHttpError
} from "../packages/git-provider/index.js";

function response(status, body = null, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? headers : { "content-type": "application/json", ...headers }
  });
}

test("putBytes returns idempotent when immutable bytes already exist", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => response(200, {
    type: "file",
    encoding: "base64",
    content: btoa("same"),
    sha: "blob-existing"
  });

  const provider = new GitHubProvider({ owner: "alice", repository: "data", token: "test" });
  const result = await provider.putBytes("events/a.json", "same");
  assert.equal(result.idempotent, true);
  assert.equal(result.commit, null);
  assert.equal(result.blob, "blob-existing");
});

test("putBytes rejects same immutable path with different bytes", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => response(200, {
    type: "file",
    encoding: "base64",
    content: btoa("old"),
    sha: "blob-existing"
  });

  const provider = new GitHubProvider({ owner: "alice", repository: "data", token: "test" });
  await assert.rejects(() => provider.putBytes("events/a.json", "new"), GitConflictError);
});

test("putManyBytes creates one tree and one commit for multiple objects", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  let blobNumber = 0;

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname;
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });

    if (method === "GET" && path.includes("/contents/")) return response(404, { message: "not found" });
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: "parent" } });
    if (method === "GET" && path.endsWith("/git/commits/parent")) return response(200, { tree: { sha: "base-tree" } });
    if (method === "POST" && path.endsWith("/git/blobs")) return response(201, { sha: `blob-${++blobNumber}` });
    if (method === "POST" && path.endsWith("/git/trees")) return response(201, { sha: "new-tree" });
    if (method === "POST" && path.endsWith("/git/commits")) return response(201, { sha: "new-commit" });
    if (method === "PATCH" && path.endsWith("/git/refs/heads/main")) return response(200, { object: { sha: "new-commit" } });
    throw new Error(`unexpected request ${method} ${path}`);
  };

  const provider = new GitHubProvider({ owner: "alice", repository: "data", token: "test" });
  const result = await provider.putManyBytes([
    { path: "events/batch.ndjson", bytes: "data" },
    { path: "receipts/batch.json", bytes: "receipt" }
  ]);

  assert.equal(result.commit, "new-commit");
  assert.equal(result.idempotent, false);
  const treeCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/git/trees"));
  assert.equal(treeCall.body.base_tree, "base-tree");
  assert.equal(treeCall.body.tree.length, 2);
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/commits")).length, 1);
});

test("putManyBytes retries a non-fast-forward ref race against the new parent", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let parentRead = 0;
  let patchCount = 0;
  const sleeps = [];

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname;
    if (method === "GET" && path.includes("/contents/")) return response(404, { message: "not found" });
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) {
      parentRead += 1;
      return response(200, { object: { sha: parentRead === 1 ? "parent-1" : "parent-2" } });
    }
    if (method === "GET" && path.endsWith("/git/commits/parent-1")) return response(200, { tree: { sha: "tree-1" } });
    if (method === "GET" && path.endsWith("/git/commits/parent-2")) return response(200, { tree: { sha: "tree-2" } });
    if (method === "POST" && path.endsWith("/git/blobs")) return response(201, { sha: "blob" });
    if (method === "POST" && path.endsWith("/git/trees")) return response(201, { sha: parentRead === 1 ? "new-tree-1" : "new-tree-2" });
    if (method === "POST" && path.endsWith("/git/commits")) return response(201, { sha: parentRead === 1 ? "commit-1" : "commit-2" });
    if (method === "PATCH" && path.endsWith("/git/refs/heads/main")) {
      patchCount += 1;
      return patchCount === 1
        ? response(422, { message: "Update is not a fast forward" })
        : response(200, { object: { sha: "commit-2" } });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };

  const provider = new GitHubProvider({
    owner: "alice",
    repository: "data",
    token: "test",
    sleep: async (ms) => { sleeps.push(ms); }
  });
  const result = await provider.putManyBytes([{ path: "events/a.json", bytes: "data" }]);
  assert.equal(result.commit, "commit-2");
  assert.equal(result.refRetries, 1);
  assert.deepEqual(sleeps, [100]);
});

test("GitHub rate-limit responses expose retry metadata and are not ref-race retried", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(429, { message: "secondary rate limit" }, { "retry-after": "30" });
  };

  const provider = new GitHubProvider({ owner: "alice", repository: "data", token: "test" });
  await assert.rejects(
    () => provider.putManyBytes([{ path: "events/a.json", bytes: "data" }]),
    (error) => {
      assert.ok(error instanceof GitProviderHttpError);
      assert.equal(error.code, "git_rate_limited");
      assert.equal(error.rateLimited, true);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("putControlObjects atomically updates a versioned catalog and immutable history", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  let blobNumber = 0;

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname;
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });

    if (method === "GET" && path.includes("/contents/openx/storage/catalog.json")) {
      return response(200, { type: "file", encoding: "base64", content: btoa("old-catalog"), sha: "catalog-v1" });
    }
    if (method === "GET" && path.includes("/contents/openx/storage/history/")) return response(404, { message: "not found" });
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: "parent" } });
    if (method === "GET" && path.endsWith("/git/commits/parent")) return response(200, { tree: { sha: "base-tree" } });
    if (method === "POST" && path.endsWith("/git/blobs")) return response(201, { sha: `blob-${++blobNumber}` });
    if (method === "POST" && path.endsWith("/git/trees")) return response(201, { sha: "tree-next" });
    if (method === "POST" && path.endsWith("/git/commits")) return response(201, { sha: "commit-next" });
    if (method === "PATCH" && path.endsWith("/git/refs/heads/main")) return response(200, { object: { sha: "commit-next" } });
    throw new Error(`unexpected request ${method} ${path}`);
  };

  const provider = new GitHubProvider({ owner: "alice", repository: "data", token: "test" });
  const result = await provider.putControlObjects([
    { path: "openx/storage/catalog.json", bytes: "new-catalog" },
    { path: "openx/storage/history/2026.json", bytes: "new-catalog" }
  ], {
    expected: { path: "openx/storage/catalog.json", blob: "catalog-v1" }
  });

  assert.equal(result.commit, "commit-next");
  assert.equal(result.idempotent, false);
  const tree = calls.find((call) => call.method === "POST" && call.path.endsWith("/git/trees"));
  assert.equal(tree.body.tree.length, 2);
});

test("putControlObjects rejects a stale expected catalog version before creating a commit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let writes = 0;

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname;
    if (method === "GET" && path.includes("/contents/openx/storage/catalog.json")) {
      return response(200, { type: "file", encoding: "base64", content: btoa("other-catalog"), sha: "catalog-v2" });
    }
    if (method === "GET" && path.includes("/contents/openx/storage/history/")) return response(404, { message: "not found" });
    writes += 1;
    throw new Error(`unexpected write ${method} ${path}`);
  };

  const provider = new GitHubProvider({ owner: "alice", repository: "data", token: "test" });
  await assert.rejects(
    () => provider.putControlObjects([
      { path: "openx/storage/catalog.json", bytes: "new-catalog" },
      { path: "openx/storage/history/2026.json", bytes: "new-catalog" }
    ], { expected: { path: "openx/storage/catalog.json", blob: "catalog-v1" } }),
    (error) => {
      assert.ok(error instanceof GitControlVersionConflictError);
      assert.equal(error.expectedBlob, "catalog-v1");
      assert.equal(error.actualBlob, "catalog-v2");
      return true;
    }
  );
  assert.equal(writes, 0);
});
