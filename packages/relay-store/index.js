function tagKey(record, tag) {
  return `tag:${encodeURIComponent(String(tag).toLowerCase())}:${record.createdAt}:${record.eventId}`;
}

export class RelayStore {
  async ingest() {
    throw new Error("RelayStore.ingest is not implemented");
  }

  async getObject() {
    throw new Error("RelayStore.getObject is not implemented");
  }

  async listTag() {
    throw new Error("RelayStore.listTag is not implemented");
  }

  async listInteractions() {
    throw new Error("RelayStore.listInteractions is not implemented");
  }

  async listTrust() {
    throw new Error("RelayStore.listTrust is not implemented");
  }
}

export class CloudflareKvRelayStore extends RelayStore {
  constructor(namespace) {
    super();
    if (!namespace) throw new Error("missing Cloudflare KV relay namespace");
    this.namespace = namespace;
  }

  async put(key, value, options) {
    await this.namespace.put(key, JSON.stringify(value), options);
  }

  async listPrefix(prefix, limit = 100) {
    const page = await this.namespace.list({ prefix, limit: Math.min(limit, 500) });
    const values = await Promise.all(page.keys.map((key) => this.namespace.get(key.name, "json")));
    return values.filter(Boolean);
  }

  async ingest(records) {
    for (const record of records) {
      await this.put(`event:${record.eventId}`, record);
      if (record.object) await this.put(`object:${record.object}`, record);

      for (const tag of record.tags || []) {
        await this.put(tagKey(record, tag), record, { expirationTtl: 60 * 60 * 24 * 90 });
      }

      if (record.target && record.kind.startsWith("reaction.")) {
        await this.put(`interaction:${record.target}:${record.actor}:${record.reaction || "like"}`, record);
      }

      if (record.target && (record.kind.startsWith("attestation.") || record.kind.startsWith("label."))) {
        await this.put(`trust:${record.target}:${record.issuer}:${record.eventId}`, record);
      }
    }
  }

  getObject(id) {
    return this.namespace.get(`object:${id}`, "json");
  }

  listTag(tag, limit) {
    return this.listPrefix(`tag:${encodeURIComponent(String(tag).toLowerCase())}:`, limit);
  }

  listInteractions(objectId, limit = 500) {
    return this.listPrefix(`interaction:${objectId}:`, limit);
  }

  listTrust(objectId, limit = 100) {
    return this.listPrefix(`trust:${objectId}:`, limit);
  }
}

export function createRelayStore(env) {
  const backend = env.RELAY_STORE || "cloudflare-kv";
  if (backend === "cloudflare-kv") return new CloudflareKvRelayStore(env.INDEX);
  throw new Error(`unsupported relay store backend: ${backend}`);
}
