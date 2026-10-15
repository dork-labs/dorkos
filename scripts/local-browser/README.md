# Local browser proofs

These scripts check the live local browser without model calls or personal browser data.
Run them from this worktree. Coordinate the shared verification slot before starting a command.

Typecheck these runners with `pnpm exec tsc -p scripts/local-browser/tsconfig.json`.

| Proof                                            | What it checks                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `cli-installed-proof.ts`                         | An isolated CLI install, real app controls, browser download and recovery, saved logins, and detach behavior. |
| `desktop-packaged-proof.ts`                      | The packaged desktop app, its native page, persistent site data, and cached browser files.                    |
| `bridge-proof.ts --execute`                      | The production native bridge, page isolation, popup ownership, and moving one page between windows.           |
| `native-consent-proof.ts --execute --surface cli | desktop`                                                                                                      | Chrome’s own permission flow in a disposable browser profile. This needs a person or an approved native UI method. |
| `prepare-desktop-natives.ts`                     | Native modules built in a private directory, with source-file identity checks.                                |

Use `python3 scripts/local-browser/run-in-lane.py <scope> <command> ...` to acquire the exclusive marker.
The scopes must contain `cli-proof`, `desktop-proof`, `bridge-proof`, `native-proof`, or `desktop-natives`, as appropriate.
A free marker alone does not replace an agreed handoff from another owner.

The CLI proof builds its own fresh package with normal `pnpm --filter dorkos build` before `npm pack --ignore-scripts`. The build uses the existing sanitized child environment and a 300-second command limit, followed by physical process cleanup. Do not substitute a prebuilt dist or an older tarball.

Source custody is recorded before build, after build, after pack, and after the proof (including failed attempts when possible). The inventory contains tracked and nonignored untracked paths, sorted hashes and modes, literal symlink targets, deleted entries, HEAD, and the lockfile hash. It never follows source symlinks or inventories ignored dist/proof outputs or `.dork`. The package receipt links its tarball SHA to that frozen source fingerprint. Any source change fails qualification and preserves the temporary install; final snapshot errors do not replace the original failure. All source writers must remain stopped for the complete build, pack, install, and runtime proof.

Proofs write receipts and media under `.dork/local-browser/`.
Read the receipt, logs, and final process census before reporting success or handing off the slot.
A failed cleanup preserves the temporary data for inspection. Delete it only after its processes have closed.

The desktop proof must use this worktree’s candidate app, never the person’s installed DorkOS app.
Build and package only after all source writers have stopped. Check archive payload hashes before launch.
Keep `HOME` and `CODEX_HOME` unchanged. The fixtures isolate their own app data and CoreFoundation home.

The early feasibility scripts are archived with hashes under `.dork/local-browser/historical-proofs/`.
They record earlier results and are not maintained entry points. An endpoint-only Chrome proof does not prove browser-native permission.
Record platform and permission gaps in every final receipt. The implementation ledger is in `specs/local-playwright-browser/04-implementation.md`.

## Installed native permission proof

The native runner consumes explicit passed artifact receipts; it never picks a latest artifact or upgrades a failed proof. Run it under a native-proof lane with a 900-second grant: worker810, physical cleanup60, coordination30. CLI requires --surface cli --receipt /absolute/passed-cli/receipt.json. Desktop requires --surface desktop --receipt /absolute/sealed.json --runtime-receipt /absolute/passed-runtime/receipt.json --candidate /absolute/worktree/candidate/DorkOS.app, plus --mechanism-receipt /absolute/passed-mechanism/outer-receipt.json. Run the same desktop command with --mechanism-only first to qualify the inspector mechanism; that result alone does not prove browser permission.

For portable desktop custody, run native-consent-proof.ts --custody --before --output /absolute/root/.dork/local-browser/custody/before.json before the separately granted normal build/pack/private-native-prepare/runtime commands. Record the normal command chain with --custody --command shared-build, then desktop-build, then desktop-pack; each later phase requires --previous /absolute/prior/receipt.json, --candidate and an explicit --electron-cache inside root/.dork. Each separately granted phase has a600-second bound. The commands use runProofCommand and direct electron-builder with npmRebuild=false; no native rebuild runs. After private native preparation and the maintained desktop runtime proof pass, run --custody --seal --build-receipt /absolute/pack/receipt.json --before-receipt /absolute/before.json --runtime-receipt /absolute/passed-runtime/receipt.json --candidate /absolute/worktree/candidate/DorkOS.app --output /absolute/root/.dork/local-browser/custody/sealed.json. The seal requires the actual successful build/pack receipt chain and every frozen desktop built-payload hash to match the candidate ASAR. A stale runtime-passed candidate cannot qualify. It checks all bundle files and ASAR payloads, frozen source, and shared native file identities. It builds, repairs, and loads nothing.

The actual installed public browser service must open existing Chrome without a URL, remain unselected, then select the exact already-running fixture tab. The same selected tab navigates, runs real scoped tools through app chat, produces Save callbacks and PNG observations, pauses/resumes, and survives detach with its cookie and active extension. The receipt records actual mode/channel/browserVersion; the supported Chrome major range is144 through155. No model is called. The only native browser launched is one disposable profile, with no debugging launch flags.

A person or an explicitly approved PID-specific UI method loads the tiny owned extension, enables Chrome's native remote-debugging setting, approves the native connection dialog, and navigates the same tab after detach. Each action must reattest output/operator-admission.json against the exact current process identity, private profile, extension hashes, lease, and deadline. Never target personal Chrome or change personal browser settings. The runner itself performs none of these native UI actions.

Native evidence is retained under .dork/local-browser/native-proof/<timestamp-uuid>, including operator-admission.json, worker-receipt.json, outer-receipt.json, protocol diagnostics, logs and media. Physical cleanup failure retains the exact owned shared-lane marker; do not release it until independent closure is confirmed. Normal app-close resolution is not physical proof. Re-run fresh artifact and native proofs after any final source promotion.

The ordinary scripts test suite runs local-browser-native-controls.test.ts. It exercises the actual serialized raw callbacks, first/post-guard pause admission, replaced-wrapper guards, late acknowledgements, disconnect and second-fork refusal without an app, browser, network or model.
