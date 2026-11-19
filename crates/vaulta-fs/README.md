# Vaulta filesystem crate

`vaulta-fs` is a Windows-only filesystem backend with no dependency on Vaulta's database,
index, UI, or core crate. It never scans for assets or invokes the Windows Shell while previewing,
saving, searching, hashing, or projecting categories.

- `resolve` returns a display path, not a retained capability. Use `*_checked` when a caller
  already knows the expected identity; these compare the `win:<volume>:<file-id>:<creation-time>`
  key on the handle used by the operation. The caller still owns vault/unit membership checks,
  user confirmation, and audit history. Don't canonicalize untrusted operands before passing them
  to this crate; doing so could hide a path's original reparse components.
- Paths use absolute local drive roots and strict relative components. `resolve`, `preview`,
  `text_matches`, `open`, and `mkdir`'s parent argument accept `""` for the root. Normal operations
  reject reparse components, streams, device names, and `.vaulta-views` (case-insensitive). Rename
  and move do not overwrite; cross-volume moves do not copy or delete. On NTFS, reusing a recently
  deleted destination name may change its creation timestamp, even though the native file ID is
  unchanged. Do not blindly retry a completed disk operation after a reconciliation error.
- Preview is bounded to 2 MiB for UTF-8 text and 12 MiB for supported raster/audio/video files.
  Render its text as a text node, never HTML, including Markdown and HTML source. Only bind the
  returned media URLs to the corresponding image/audio/video element. For PDF and supported
  Office-family documents, `preview` returns only a renderer kind; `open_render_source` verifies
  the file identity and exposes bounded bytes (up to 64 MiB) for the desktop host. Document text
  extraction is exclusive to `text_matches`. Duplicate groups are identified by size and streamed SHA-256 of the unnamed
  stream, not used as file identity, and never trigger merging or deletion.
- `save_text_verified_checked` atomically commits content using a Windows TxF-capable filesystem,
  comparing content revision, native identity, and single-link state while handles are open. It
  returns the new revision and verified path without reopening the path. This edits the original
  unnamed stream and retains the file ID, file ACL, and alternate streams. The UTF-8 BOM, if any,
  is retained; the caller supplies the intended newlines. TxF is a deprecated, optional Windows
  capability; where unavailable, advise editing externally. No unsafe in-place fallback is used.
- Shell operations are explicit; default/choose only allow known document/media types. `run`
  currently supports native `.exe` with explicit authorization. Shell launch behavior for allowed
  documents still depends on the user's installed associations. Recycle uses Windows Shell and
  requests a recoverable item, with no permanent-delete code path; unconfirmed/cancelled Shell
  operations are errors. Do not retry as permanent deletion. A Shell operation is path-based and
  not a general security boundary against other processes with write access to a vault.

## Projection handoff

Pass a complete, current authoritative snapshot. `sync_view_checked` accepts an optional expected identity per asset ID (omit entries you cannot check). A stable pass does not rewrite the manifest. `sync_view(..., true, true)` checks the persisted
manifest and reports only identifiable changes. If `changes` is nonempty, commit them in core,
refresh the snapshot, then call with `enabled=true, import=false`. The first call does not generate
or remove links while an import is pending. `import=false` skips interpretation and materializes
current metadata; `enabled=false` removes only verifiable links created by Vaulta. Existing foreign
links can be observed but are never adopted as owned. Real files, foreign links, and ordinary
directories are not cleaned up. Targets are not opened through any projected path.

An unrecognized manifest or nonempty unowned view tree is left alone. A Windows symlink privilege
failure or ambiguous view edit is a warning. Manifest updates are atomic; link updates and the
manifest itself are not a single multi-file transaction. For example, a crash after a link is
created but before ownership is recorded may leave that link unmanaged rather than risk deleting
an unverified entry later. The view is not a backup or a trust boundary against external tools
with full write access to its manifest.

## Local verification

```powershell
cargo test -p vaulta-fs --locked
cargo test -p vaulta-fs --locked recycle_only -- --ignored
cargo clippy -p vaulta-fs --all-targets --locked -- -D warnings
```

The opt-in test uses disposable fixtures and will leave recoverable entries in the real Recycle
Bin. The save test checks actual atomic saves on a TxF-capable local volume; the projection test
exercises link operations when symlink creation is available.

