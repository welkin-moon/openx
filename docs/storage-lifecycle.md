# User storage lifecycle

OpenX user repositories are segmented object stores. Clients and relays should
not clone them during normal operation. They read exact immutable objects,
segment catalogs and generated indexes through provider APIs or static HTTP.

## Why `.gitignore` is not deletion

`.gitignore` only changes which untracked files a local Git client considers for
future additions. It does not remove tracked files, rewrite commits, make old
blobs unreachable, or reclaim remote repository storage.

OpenX may include `.gitignore` entries for local build files and temporary
exports, but it is not part of the user-data retention design.

## Active segment

A node writes into one active repository segment. Default sealing thresholds:

- 30 days old;
- 512 MiB of reachable objects;
- 50,000 objects;
- 10,000 commits.

Any threshold can seal the segment. Deployments may choose lower limits.

Object paths are date and hash sharded:

```text
events/live/YYYY/MM/DD/aa/bb/<sha256>.json
events/live/YYYY/MM/DD/aa/bb/batch-<sha256>.ndjson
media/aa/bb/<sha256>.bin
```

The path is a location, not an object identity.

## Normal compaction

Normal compaction creates pack and index objects, then publishes a fresh
snapshot ref whose root commit has no parent. The new snapshot contains only
currently retained objects and packs.

This has three effects:

1. new readers see a small reachable history;
2. normal API/static reads do not traverse the old commit chain;
3. migration can copy the snapshot rather than every historic commit.

A force-updated ref does not guarantee immediate physical deletion of old
objects by a hosting provider. Old commits may remain in provider caches,
forks, clones or internal garbage collection until the provider removes them.
Therefore this mechanism is storage hygiene, not a cryptographic erasure
promise.

## Strong deletion

For deletion that should not remain in the user's active Git storage:

1. revoke access keys when relevant;
2. publish a signed withdrawal/restriction event;
3. create a fresh repository segment containing only retained ciphertext;
4. publish a new signed segment catalog and object-location set;
5. move readers and relays to the new segment;
6. delete the old repository through the provider;
7. request provider history/cache removal when policy or law requires it.

Copies already downloaded by other parties cannot be remotely erased.

## Rotation rather than endless rewriting

When a segment is sealed, the node creates the next segment:

```text
openx-data-0001  sealed
openx-data-0002  active
```

A signed catalog identifies active and sealed segments. Repositories are
replaceable locations; identities, post IDs and reply IDs do not change.

Media uses the same policy but normally rotates sooner because it consumes more
space.

## Read path

Normal readers use:

```text
relay pointer / node catalog
  -> exact Git object or static object URL
  -> local hash verification
  -> local decryption
```

They do not run `git clone`, `git pull` or scan complete repository trees.
Administrative export remains available as an optional full clone or bundle.
