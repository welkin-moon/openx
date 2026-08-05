const utf8 = new TextEncoder();

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(String(value).replaceAll("\n", ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function normalizePath(path) {
  const normalized = String(path).replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) throw new Error("invalid git object path");
  return normalized;
}

function asBytes(value) {
  return value instanceof Uint8Array ? value : utf8.encode(String(value));
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class GitConflictError extends Error {
  constructor(path) {
    super(`immutable Git object already exists with different bytes: ${path}`);
    this.name = "GitConflictError";
    this.code = "git_object_conflict";
    this.path = path;
  }
}

/**
 * Portable storage adapter boundary.
 * Protocol IDs are hashes/DIDs; provider URLs are replaceable locations.
 */
export class GitProvider {
  constructor(config) {
    this.provider = config.provider;
    this.owner = config.owner;
    this.repository = config.repository;
    this.branch = config.branch || "main";
  }

  descriptor() {
    return {
      type: "git",
      provider: this.provider,
      repository: `${this.owner}/${this.repository}`,
      ref: this.branch,
      capabilities: [
        "git.contents.write",
        "git.objects.read",
        "git.immutable-event-log",
        "git.atomic-tree-commit"
      ]
    };
  }

  objectRef(path) {
    return {
      type: "git-object",
      provider: this.provider,
      repository: `${this.owner}/${this.repository}`,
      ref: this.branch,
      path: normalizePath(path)
    };
  }

  async getBytes() {
    throw new Error("GitProvider.getBytes is not implemented");
  }

  async putBytes() {
    throw new Error("GitProvider.putBytes is not implemented");
  }

  async putManyBytes() {
    throw new Error("GitProvider.putManyBytes is not implemented");
  }
}

export class GitHubProvider extends GitProvider {
  constructor(config) {
    super({ ...config, provider: "github" });
    this.apiBase = config.apiBase || "https://api.github.com";
    this.token = config.token;
    if (!this.owner || !this.repository || !this.token) throw new Error("incomplete GitHub provider configuration");
  }

  descriptor() {
    return { ...super.descriptor(), apiBase: this.apiBase };
  }

  async request(path, init = {}, acceptedStatuses = []) {
    const response = await fetch(`${this.apiBase}/repos/${this.owner}/${this.repository}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "openx-node/0.0.1",
        ...(init.headers || {})
      }
    });

    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      const body = await response.text();
      const error = new Error(`git provider returned ${response.status}: ${body}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204 || response.status === 404) return null;
    return response.json();
  }

  async getBytes(path, { branch = this.branch } = {}) {
    const objectPath = normalizePath(path);
    const result = await this.request(`/contents/${objectPath}?ref=${encodeURIComponent(branch)}`, {}, [404]);
    if (!result) return null;
    if (result.type !== "file" || result.encoding !== "base64") throw new Error(`unsupported GitHub object at ${objectPath}`);
    return { bytes: decodeBase64(result.content), blob: result.sha, location: this.objectRef(objectPath) };
  }

  async putBytes(path, value, { message, branch = this.branch } = {}) {
    const objectPath = normalizePath(path);
    const bytes = asBytes(value);
    const existing = await this.getBytes(objectPath, { branch });

    if (existing) {
      if (!equalBytes(existing.bytes, bytes)) throw new GitConflictError(objectPath);
      return { commit: null, blob: existing.blob, location: existing.location, idempotent: true };
    }

    const result = await this.request(`/contents/${objectPath}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: message || `openx: write ${objectPath}`,
        content: encodeBase64(bytes),
        branch
      })
    });

    return {
      commit: result.commit?.sha || null,
      blob: result.content?.sha || null,
      location: this.objectRef(objectPath),
      idempotent: false
    };
  }

  async putManyBytes(entries, { message, branch = this.branch } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("entries must be a non-empty array");

    const normalized = entries.map((entry) => ({
      path: normalizePath(entry.path),
      bytes: asBytes(entry.bytes)
    }));
    if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
      throw new Error("duplicate paths in atomic Git write");
    }

    const existing = await Promise.all(normalized.map((entry) => this.getBytes(entry.path, { branch })));
    const pending = [];
    for (let index = 0; index < normalized.length; index += 1) {
      if (!existing[index]) pending.push(normalized[index]);
      else if (!equalBytes(existing[index].bytes, normalized[index].bytes)) throw new GitConflictError(normalized[index].path);
    }

    if (pending.length === 0) {
      return {
        commit: null,
        locations: normalized.map((entry) => this.objectRef(entry.path)),
        idempotent: true
      };
    }

    const ref = await this.request(`/git/ref/heads/${encodeURIComponent(branch)}`);
    const parentCommit = await this.request(`/git/commits/${ref.object.sha}`);
    const blobs = await Promise.all(pending.map((entry) => this.request("/git/blobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: encodeBase64(entry.bytes), encoding: "base64" })
    })));

    const tree = await this.request("/git/trees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: pending.map((entry, index) => ({
          path: entry.path,
          mode: "100644",
          type: "blob",
          sha: blobs[index].sha
        }))
      })
    });

    const commit = await this.request("/git/commits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: message || `openx: write ${pending.length} objects`,
        tree: tree.sha,
        parents: [ref.object.sha]
      })
    });

    await this.request(`/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false })
    });

    return {
      commit: commit.sha,
      locations: normalized.map((entry) => this.objectRef(entry.path)),
      idempotent: false
    };
  }
}

export function createGitProvider(env) {
  const provider = env.GIT_PROVIDER || "github";
  if (provider === "github") {
    return new GitHubProvider({
      apiBase: env.GIT_API_BASE || "https://api.github.com",
      owner: env.GIT_OWNER || env.GITHUB_OWNER,
      repository: env.GIT_REPOSITORY || env.GITHUB_REPO,
      branch: env.GIT_BRANCH || env.GITHUB_BRANCH || "main",
      token: env.GIT_TOKEN || env.GITHUB_TOKEN
    });
  }
  throw new Error(`unsupported git provider: ${provider}`);
}
