# Vaulta core (Windows x64)

`Core::open` opens the shared SQLite metadata file. SQLite serializes writes across
processes; read APIs use short, consistent snapshots. `revision()` is a durable
visibility marker, not an event sequence: no-op scans and no-op logical mutations do
not advance it. Startup, watcher scheduling, and the cooperative lock around
filesystem workflows are owned by the caller.

## Availability and identity

- `Vault.status` is `ready` (last full scan succeeded, or newly registered),
  `partial` (the root was verified but some observations could not be trusted),
  or `unavailable` (the root could not be verified/listed or the owning unit is
  missing or excluded). `scan()` records these states without treating them as
  database errors. Neither partial nor unavailable scans mark assets missing.
- `get_vault()` and `snapshot()` can return last-known metadata while offline.
  Call `checked_root()` before physical I/O; it verifies the root and owning-unit
  chain independently of scan status. It returns a checked path, **not** a pinned
  handle. Filesystem operations must still verify their target at the point of use.
- `identity()` uses a native volume serial, 128-bit file ID and full creation
  timestamp. It returns `None` for a final reparse point and an error for I/O
  failure or an unsafe ancestor. Traversal skips reparse points and
  `.vaulta-views` at every level. If the filesystem does not supply a usable ID,
  Core does not guess from paths or file contents.
- A copy receives a new asset ID. Simultaneous hard-link names are distinct
  assets with the same physical identity, and ambiguous renames are not merged.
  A scan is not a filesystem snapshot: alias churn between scans and external /
  cross-volume moves are not always identifiable. Old records remain available as
  `missing`; explicit `recover_identity` can transfer metadata to a verified,
  unorganized inbox asset (not a unit). `rebind` is for caller-verified explicit
  moves or same-path atomic saves, not a scan fallback.

## Logical metadata

Categories, tags, flags, file states, view configuration and agent access do not
change real files. Agent access is stored and audited; the caller enforces access
for its cooperative API. Undo only reverses supported logical mutations. It
checks the recorded post-state and referential integrity instead of overwriting
metadata that no longer matches. No undo path restores physical files.

`remove_vault()` detaches a top-level vault, hides its child registry and revokes
agent permissions. It retains data and restores it when the same verified root is
added at the same path. Child roots follow their owning unit after reconciliation.
Designate a containing folder as a unit before designating units inside it; Core
rejects wrapping an existing unit in the same outer space instead of silently
moving the child library. When designating a unit, older outer descendant records
are retained but hidden while inside the boundary; child organization is separate.
