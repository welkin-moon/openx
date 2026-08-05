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

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("entries must be a non-empty array");
  const normalized = entries.map((entry) => ({
    path: normalizePath(entry.path),
    bytes: asBytes(entry.bytes)
  }));
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw new Error("duplicate paths in atomic Git write");
  }
  return normalized;
}

function parseRetryAfter(headers, now = Date.now()) {
  const value = headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, (reset * 1_000) - now);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitConflictError extends Error {
  constructor(path) {
    super(`immutable Git object already exists with different bytes: ${path}`);
    this.name = "GitConflictError";
    this.code = "git_object_conflict";
    this.path = path;
  }
}

export class GitControlVersionConflictError extends Error {
  constructor(path, expectedBlob, actualBlob) {
    super(`Git control object changed since it was read: ${path}`);
    this.name = "GitControlVersionConflictError";
    this.code = "git_control_version_conflict";
    this.path = path;
    this.expectedBlob = expectedBlob ?? null;
    this.actualBlob = actualBlob ?? null;
  }
}

export class GitProviderHttpError extends Error {
  constructor(status, body, headers = new Headers()) {
    super(`git provider returned ${status}: ${body}`);
    this.name = "GitProviderHttpError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = parseRetryAfter(headers);
    this.rateLimited = status === 429 || (status === 403 && (
      headers.get("x-ratelimit-remaining") === "0" || /secondary rate limit|rate limit exceeded/iu.test(body)
    ));
    this.code = this.rateLimited ? "git_rate_limited" : `git_http_${status}`;
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
        "git.atomic-tree-commit",
        "git.concurrent-ref-retry",
        "git.control-plane-cas"
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

  async putControlObjects() {
    throw new Error("GitProvider.putControlObjects is not implemented");
  }
}

export class GitHubProvider extends GitProvider {
  constructor(config) {
    super({ ...config, provider: "github" });
    this.apiBase = config.apiBase || "https://api.github.com";
    this.token = config.token;
    this.maxRefRetries = Number(config.maxRefRetries ?? 3);
    this.refRetryBaseMs = Number(config.refRetryBaseMs ?? 100);
    this.sleep = config.sleep || sleep;
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
      throw new GitProviderHttpError(response.status, body, response.headers);
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

    try {
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
    } catch (error) {
      if (!(error instanceof GitProviderHttpError) || error.status !== 422) throw error;
      const raced = await this.getBytes(objectPath, { branch });
      if (!raced) throw error;
      if (!equalBytes(raced.bytes, bytes)) throw new GitConflictError(objectPath);
      return { commit: null, blob: raced.blob, location: raced.location, idempotent: true };
    }
  }

  async inspectEntries(normalized, branch) {
    const existing = await Promise.all(normalized.map((entry) => this.getBytes(entry.path, { branch })));
    const pending = [];
    for (let index = 0; index < normalized.length; index += 1) {
      if (!existing[index]) pending.push(normalized[index]);
      else if (!equalBytes(existing[index].bytes, normalized[index].bytes)) throw new GitConflictError(normalized[index].path);
    }
    return { existing, pending };
  }

  async createAtomicCommit(pending, message, branch) {
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
        message,
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
      blobs: Object.fromEntries(pending.map((entry, index) => [entry.path, blobs[index].sha]))
    };
  }

  async putManyBytes(entries, { message, branch = this.branch } = {}) {
    const normalized = normalizeEntries(entries);

    for (let attempt = 0; attempt <= this.maxRefRetries; attempt += 1) {
      const inspection = await this.inspectEntries(normalized, branch);
      if (inspection.pending.length === 0) {
        return {
          commit: null,
          blobs: Object.fromEntries(normalized.map((entry, index) => [entry.path, inspection.existing[index].blob])),
          locations: normalized.map((entry) => this.objectRef(entry.path)),
          idempotent: true,
          refRetries: attempt
        };
      }

      try {
        const result = await this.createAtomicCommit(
          inspection.pending,
          message || `openx: write ${inspection.pending.length} objects`,
          branch
        );
        return {
          commit: result.commit,
          blobs: {
            ...Object.fromEntries(normalized
              .map((entry, index) => inspection.existing[index] ? [entry.path, inspection.existing[index].blob] : null)
              .filter(Boolean)),
            ...result.blobs
          },
          locations: normalized.map((entry) => this.objectRef(entry.path)),
          idempotent: false,
          refRetries: attempt
        };
      } catch (error) {
        const refRace = error instanceof GitProviderHttpError && error.status === 422 && !error.rateLimited;
        if (!refRace || attempt >= this.maxRefRetries) throw error;
        await this.sleep(this.refRetryBaseMs * (2 ** attempt));
      }
    }
    throw new Error("unreachable Git ref retry state");
  }

  async putControlObjects(entries, { expected, message, branch = this.branch } = {}) {
    const normalized = normalizeEntries(entries);
    const expectedPath = normalizePath(expected?.path || "");
    if (!Object.prototype.hasOwnProperty.call(expected || {}, "blob")) {
      throw new Error("control write requires expected.blob, including null for creation");
    }
    const expectedIndex = normalized.findIndex((entry) => entry.path === expectedPath);
    if (expectedIndex < 0) throw new Error("control write set must contain the expected control object");

    for (let attempt = 0; attempt <= this.maxRefRetries; attempt += 1) {
      const existing = await Promise.all(normalized.map((entry) => this.getBytes(entry.path, { branch })));
      const allSame = normalized.every((entry, index) => existing[index] && equalBytes(existing[index].bytes, entry.bytes));
      if (allSame) {
        return {
          commit: null,
          blobs: Object.fromEntries(normalized.map((entry, index) => [entry.path, existing[index].blob])),
          locations: normalized.map((entry) => this.objectRef(entry.path)),
          idempotent: true,
          refRetries: attempt
        };
      }

      const actualBlob = existing[expectedIndex]?.blob ?? null;
      const expectedBlob = expected.blob ?? null;
      if (actualBlob !== expectedBlob) {
        throw new GitControlVersionConflictError(expectedPath, expectedBlob, actualBlob);
      }

      const pending = [];
      for (let index = 0; index < normalized.length; index += 1) {
        const entry = normalized[index];
        const current = existing[index];
        if (entry.path === expectedPath) {
          if (!current || !equalBytes(current.bytes, entry.bytes)) pending.push(entry);
        } else if (!current) {
          pending.push(entry);
        } else if (!equalBytes(current.bytes, entry.bytes)) {
          throw new GitConflictError(entry.path);
        }
      }

      try {
        const result = await this.createAtomicCommit(
          pending,
          message || `openx: update control object ${expectedPath}`,
          branch
        );
        return {
          commit: result.commit,
          blobs: {
            ...Object.fromEntries(normalized
              .map((entry, index) => existing[index] && !pending.some((item) => item.path === entry.path)
                ? [entry.path, existing[index].blob]
                : null)
              .filter(Boolean)),
            ...result.blobs
          },
          locations: normalized.map((entry) => this.objectRef(entry.path)),
          idempotent: false,
          refRetries: attempt
        };
      } catch (error) {
        const refRace = error instanceof GitProviderHttpError && error.status === 422 && !error.rateLimited;
        if (!refRace || attempt >= this.maxRefRetries) throw error;
        await this.sleep(this.refRetryBaseMs * (2 ** attempt));
      }
    }
    throw new Error("unreachable Git control ref retry state");
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
      token: env.GIT_TOKEN || env.GITHUB_TOKEN,
      maxRefRetries: env.GIT_MAX_REF_RETRIES || 3,
      refRetryBaseMs: env.GIT_REF_RETRY_BASE_MS || 100
    });
  }
  throw new Error(`unsupported git provider: ${provider}`);
}
