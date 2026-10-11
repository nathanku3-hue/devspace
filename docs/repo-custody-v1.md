# Repository Scope & Custody v1

DevSpace owns physical execution/custody, **not** Meta-Harness product acceptance.
A Git commit, checksum or DevSpace close receipt must never be promoted directly to
an accepted World, Claim, roadmap gate or outcome.

## Workspace and write boundary

- The configured allowed roots authorize **discovery**, not write access to all
  descendants. Non-Git parent folders and nested subdirectories are read-only
  through the write/edit/rename/shell/publish tools.
- A write-capable session must open the **exact canonical Git top-level** with
  a valid HEAD. Opening/restoring a workspace also checks that its physical
  real path stays under the canonical configured allowed roots.
- Native file reads enforce canonical target containment (with explicit skill
  read roots as narrow exceptions); explicit search/directory scope paths
  are checked before dispatch. Recursive tool traversal is not treated as a
  substitute for an OS filesystem sandbox.
- Native file writes refuse paths escaping the checkout via existing symlink,
  junction or reparse-point components and refuse writing under `.git`.
- An exclusive SQLite write lease binds the physical checkout to one
  `workspaceSessionId` until verified close or detach. This fences multiple
  DevSpace workspace sessions, including across server restart. To work in
  parallel, use independent Git worktrees.
- Leases **do not** fence external editors, direct shell subprocesses or
  several callers intentionally sharing the *same* workspaceId. Such
  interference is detected where evidence permits; actor-level identity and
  operating-system isolation remain separate work.

## Physical artifacts

- Native write/edit/rename registers intent before mutation and verifies its
  post-write bytes. Previously dirty, protected or externally changed paths are
  denied before write.
- Close compares all **Git-visible** changed files, irrespective of extension,
  against the durable opening snapshot. New/unattributed `.py`, `.ts`, `.json`,
  documents or deleted paths prevent a verified close. The exact recorded
  eligible paths alone may be committed through a private index; push=false.
- Ignored/disposable files (e.g. `.scratch`, `node_modules`, `.gitignore`
  exclusions) are never automatically committed, quarantined or deleted.
  Git status cannot attest ignored shell-generated outputs.
- `commit_and_close` and legacy `close_workspace` are local, exact-path,
  proof-bearing commit-and-close calls. `detach_workspace` retires the session
  with **no commit**, preserves physical files and reports unresolved
  Git-visible changes and native recorded intents.
- The terminal receipt is stored atomically with the closed session state.
  Repeating a close after a lost transport response replays the same receipt,
  without another Git commit.
- Receipt authority is `PHYSICAL_CUSTODY_ONLY`. SHA-256 is a checksum, **not**
  a server cryptographic signature or permission to accept product meaning.

## Shell and process limitation

On Windows, the native Bash execution path is **not a filesystem sandbox**.
A Git worktree separates Git files/indexes, not OS write privileges. Shell is
restricted to an exact Git workspace at entry; after execution its
unattributed Git-visible effects block verified close. This does **not** prevent
a malicious or misbehaving shell command from writing outside the repo.
Do not present post-run detection as preventive root containment.

The production supervisor's Job Object can kill descendants when the origin
exits **if that supervisor is installed and activated**. A durable SQLite
operation journal retains operation IDs and terminal state without shell
commands/stdout. In-flight work after origin restart becomes `UNKNOWN`, not
automatically failed, successful or retried. External effects require
independent reconciliation.

## Release/version proof

`devspace_runtime_identity` reports schema revision, build manifest digest
and whether the on-disk compiled build matches its manifest and predates
the running origin. `UNVERIFIED` / `STALE_RUNTIME` block claims that the
live connector has the latest code. Source HEAD may be dirty and is not
automatically equivalent to the binary digest or to the host's installed MCP
tool schema. Build, authenticated tool discovery, deployment activation and
host schema refresh are separate steps.

## Acceptance focus

- non-Git parent and nested checkout writes denied; native symlink escape denied
- concurrent sessions on one checkout conflict; separate worktrees independent
- native session paths covered, unrelated staging preserved; unowned files block
- detach leaves unowned files in place, returns unresolved paths
- close duplicate/restart replays identical persisted custody receipt
- long-task interrupted at restart becomes UNKNOWN; raw output not persisted
- Windows Job Object behavior is separately tested, not assumed from source

**Not yet proven:** OS-level shell filesystem containment; actor-level
provenance for callers sharing a workspaceId; full attestation of ignored and
external shell-created artifacts; production activation of this source version.
