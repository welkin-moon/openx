import test from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider, GitConflictError } from "../packages/git-provider/index.js";

function response(status, body = null) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "content-type": "application/json" }
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
