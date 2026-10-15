# Local browser proofs

These scripts check two browser choices without model calls or personal browser data:

- **DorkOS browser:** a page inside the desktop app, selected by default there.
- **New browser window:** a separate visible window, selected by default in the web app.

The web app shows the DorkOS browser choice as unavailable. Connecting an existing personal browser belongs to follow-up work.

## Running a proof

These proofs need a graphical host. The installed CLI proof opens a visible browser window, even though its UI driver runs headless. The desktop proof opens this worktree's candidate app. Neither uses the person's installed DorkOS app or personal browser profile.

Run from this worktree. Agree on the shared verification slot before starting. Acquire its exclusive marker with:

```bash
python3 scripts/local-browser/run-in-lane.py <scope> <command> ...
```

Use a scope containing `cli-proof`, `desktop-proof`, `bridge-proof`, or `desktop-natives`, as appropriate. A free marker does not replace an agreed handoff.

| Proof                                  | What it checks                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cli-installed-proof.ts`               | A fresh CLI install, two choices, real browser preparation and cancellation, page tools, Pause, and saved sign-ins. |
| `desktop-packaged-proof.ts --execute`  | The actual Browser panel, its native page, a new visible window, saved sign-ins, and restart behavior.              |
| `bridge-proof.ts --execute`            | The desktop's private page bridge, page isolation, popup ownership, and moving one page between windows.            |
| `prepare-desktop-natives.ts --execute` | Native modules prepared privately for the candidate, with shared source-file identity checks.                       |

The desktop entry points keep launch and shutdown ownership. Their support files hold renderer assertions, isolated environment setup, and private native staging checks; importing them starts no app or compiler.

Typecheck the maintained runners with `pnpm exec tsc -p scripts/local-browser/tsconfig.json`.

## Fresh installed CLI

The CLI proof runs normal `pnpm --filter dorkos build` before `npm pack --ignore-scripts`. Each build or install command has a 300-second limit and physical process cleanup. Do not substitute older build output or a tarball from another attempt.

It records source fingerprints before build, after build, after pack, and after the proof. These include tracked and nonignored untracked files, modes, literal symlink targets, deleted files, HEAD, and the lockfile hash. The inventory never follows source symlinks or includes ignored build output and `.dork` evidence. The package receipt binds the tarball hash to that source fingerprint.

Keep source writers stopped throughout build, pack, install, and runtime checks. Changed source fails qualification and preserves the temporary install. A final snapshot failure does not replace an earlier proof error.

The installed app owns a fresh browser cache and private data directory. Its first UI open must show real download progress. The proof cancels, retries, and exercises the actual page tools. A later restart checks saved sign-ins and cache reuse while installer network access is unavailable.

## Packaged desktop

Build and package only after all source writers stop. Check every archive payload against the frozen build before launching. Use this worktree's candidate app and private fixture home. Keep `HOME` and `CODEX_HOME` unchanged.

The proof opens the real Browser controls and checks both choices. It verifies the default embedded page's visible bounds and pixels. Closing and reopening the panel must keep the same connection and native page. It also checks a new visible browser window, saved sign-ins, cache reuse, and parent-app closure.

The private desktop page bridge is required by the embedded mode. Its debugging transport targets that owned page; it does not attach to a personal browser.

Use an already-qualified private native cache when it matches the candidate's Electron version and hashes. Keep its reuse receipt with the fresh package evidence. Private preparation must never rewrite shared dependency binaries or the person's installed app.

## Evidence and limits

Receipts and media stay under `.dork/local-browser/`. Read the actual receipt, logs, screenshots, and final process census before claiming success. Use explicit paths from the current attempt. Older passed receipts qualify only their recorded bytes.

A failed cleanup preserves temporary data. Remove it only after its processes have closed. Keep the shared slot held when physical closure remains uncertain.

These runners do not prove Windows or Linux installed behavior. Their fixtures use the test-mode runtime and make no model calls. Existing-browser permission and extension-retention evidence stays outside the first shipment. Historical and ignored evidence remains preserved separately.

The implementation ledger is `specs/local-playwright-browser/04-implementation.md`.
