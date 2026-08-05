const utf8 = new TextEncoder();

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function normalizePath(path) {
  const normalized = String(path).replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) throw new Error("invalid git object path");
  return normalized;
}

/**
 * Storage adapter boundary for OpenX.
 *
 * Protocol objects identify content by hash. Provider URLs are replaceable
 * locations and MUST NOT be used as post, reply or identity identifiers.
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
        "git.immutable-event-log"
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

  async putBytes() {
    throw new Error("GitProvider.putBytes is not implemented");
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
    return {
      ...super.descriptor(),
      apiBase: this.apiBase
    };
  }

  async request(path, init = {}) {
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
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`git provider returned ${response.status}: ${body}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async putBytes(path, bytes, { message, branch = this.branch } = {}) {
    const objectPath = normalizePath(path);
    const content = encodeBase64(bytes instanceof Uint8Array ? bytes : utf8.encode(String(bytes)));
    const result = await this.request(`/contents/${objectPath}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: message || `openx: write ${objectPath}`, content, branch })
    });
    return {
      commit: result.commit?.sha || null,
      blob: result.content?.sha || null,
      location: this.objectRef(objectPath)
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
