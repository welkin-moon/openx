const DB_VERSION = 1;
const STORE = "entries";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

export function openOutboxDatabase(indexedDBImpl = indexedDB, name = "openx-outbox") {
  if (!indexedDBImpl) throw new Error("IndexedDB is unavailable");
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(name, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: "eventId" });
        store.createIndex("state", "state", { unique: false });
        store.createIndex("queuedAt", "queuedAt", { unique: false });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

export class IndexedDbOutboxStore {
  constructor(database) {
    this.database = database;
  }

  async getAll() {
    const transaction = this.database.transaction(STORE, "readonly");
    const values = await requestResult(transaction.objectStore(STORE).getAll());
    await transactionDone(transaction);
    return values.sort((left, right) => left.queuedAt - right.queuedAt || left.eventId.localeCompare(right.eventId));
  }

  async put(entry) {
    const transaction = this.database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(entry);
    await transactionDone(transaction);
    return entry;
  }

  async putMany(entries) {
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const entry of entries) store.put(entry);
    await transactionDone(transaction);
    return entries;
  }

  async delete(eventId) {
    const transaction = this.database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(eventId);
    await transactionDone(transaction);
  }

  async deleteCommitted() {
    const entries = await this.getAll();
    const committed = entries.filter((entry) => entry.state === "committed");
    if (committed.length === 0) return 0;

    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const entry of committed) store.delete(entry.eventId);
    await transactionDone(transaction);
    return committed.length;
  }

  close() {
    this.database.close();
  }
}

export async function createIndexedDbOutboxStore(options = {}) {
  const database = await openOutboxDatabase(options.indexedDB, options.name);
  return new IndexedDbOutboxStore(database);
}
