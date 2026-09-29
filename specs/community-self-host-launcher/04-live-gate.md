# Credentialed launcher acceptance gate

Refs DOR-2169, task 4.3. Status: implemented and locally tested; the actual provider run remains outstanding.

`pnpm --filter dorkos test:community-live` installs an exact published version, refuses a release without the launcher, and runs that installed CLI against explicitly designated disposable Fly, Neon and Tigris resources. It interrupts and resumes owner setup, checks the applied bootstrap-secret rotation, signs in through the public HTTP contract, posts and downloads a private attachment, and verifies anonymous denial. Secrets stay in private temporary files or memory; the clipboard handoff uses a private local socket.

The gate requires every `DORKOS_COMMUNITY_LIVE_*` arm, an exact published version (or an unreleased tarball, below), provider organization and region, charge acknowledgement, and operator-designated budget before it may start. The budget is recorded, not a provider-enforced billing cap. Ordinary verification and CI do not receive these variables. No production origin is accepted by the HTTP proof.

Cleanup verifies recorded provider identities before deleting the disposable resources. If failure leaves resources behind, it preserves the deployment journal and prints a recovery command using the exact published `npx` package, with an explicitly quoted `DORK_HOME`, which remains usable after the temporary install is removed. Successful nonsecret receipts are written outside both cleanup directories. An execution regression runs that command through an executable package-manager stand-in after removing a disposable installation and verifies its exact arguments and ability to read a retained fixture journal. This proves command durability; it is not a full provider-failure cleanup rehearsal.

## Unreleased tarball mode

A launcher fix used to need a release before the gate could try it against the real services. The gate can instead install an unreleased package tarball. Set `DORKOS_COMMUNITY_LIVE_PACKAGE_TARBALL` to the tarball's absolute path **instead of** `DORKOS_COMMUNITY_LIVE_VERSION`. Setting both, or neither, is refused. Every arm, the charge acknowledgement and the budget are still required, and nothing about the run changes except where the launcher comes from.

The tarball replaces only the launcher. It still deploys the published Community image and signed release manifest for the package's own version, so the launcher has to accept that release. A launcher is built with a fingerprint of `apps/community/migrations` (`scripts/build.ts`), and it refuses any release manifest whose fingerprint differs (`COMMUNITY_RELEASE_INVALID`). It refuses before it writes a launch record, so nothing is created and nothing is spent. Once `main` gains a Community migration after its last release, a tarball packed from `main` can never deploy that release. So a checkout after its release commit is not enough on its own: its Community migrations must also be the release's.

If they are, pack from a clean checkout at the commit you want to test:

```sh
git worktree add /tmp/dorkos-pack <commit>
cd /tmp/dorkos-pack
pnpm install --frozen-lockfile
pnpm --filter dorkos pack:community-live -- --out /absolute/output/directory
```

If `main` has moved past the release's migrations, pack from the release tag plus only the launcher commits under test:

```sh
git fetch --tags
git worktree add -b live-gate/<name> /tmp/dorkos-pack v<version>
cd /tmp/dorkos-pack
git cherry-pick <launcher commit>...
pnpm install --frozen-lockfile
pnpm --filter dorkos pack:community-live -- --out /absolute/output/directory
```

The recipe checks this before it builds. It refuses when the `.sql` files directly in `apps/community/migrations` (what the fingerprint covers) differ between `v<version>` and `HEAD`, and names each changed migration. It also refuses when the tag is not in the checkout, and says to run `git fetch --tags`.

`scripts/pack-community-live-tarball.ts` refuses a checkout with uncommitted changes, both before packing and after the build, and refuses if `HEAD` moved during the build. It writes into a fresh `<out>/<commit>/` directory and refuses one that already exists, so a second pack can never overwrite a tarball an earlier run's recovery command still names. Builds are not byte-reproducible, so an overwrite would swap in different code. It builds the CLI with `pnpm --filter dorkos build` and packs it with `pnpm pack`, which rewrites workspace dependency ranges the way publishing does and `npm pack` would not. Beside the tarball it writes `<tarball>.provenance.json`, which records the commit, the package version and the tarball's sha256.

Before any npm, profile or service call, the gate copies the tarball into the run's retained directory (`<DORK_HOME>/live-gate/<app>/package-under-test/`) and checks the copy. The only process involved is a local `tar` read. The original must be a regular file, not a link, and its sidecar must be complete and say the checkout was clean. The copy's sha256 must match the sidecar's. The copy's `package/package.json` must be `dorkos` at the sidecar's version. From then on only the copy is used: the gate skips the npm "is it published" check and runs `npm install` on the copy into its private prefix, and the recovery command installs from the copy with `npx --package`. Replacing or repacking the original after the check changes nothing. The copy survives a failed run with the rest of the retained directory and is removed with it on success.

The receipt's `source` block reads `{ kind: 'tarball', released: false, file, sha256, commit, packageVersion }`; a published run records `{ kind: 'release', released: true, version }`. The top-level `version` is always the Community image and signed-manifest version the launcher deployed. For a tarball run that is the package's own version, not a claim that this code was released. `commit` comes from the local sidecar the pack recipe wrote. The gate checks that the sidecar matches the tarball, but it does not check the commit against a remote, so whoever cites the receipt must confirm the commit is where they say it is.

A tarball run is evidence about unreleased launcher code, never about a release.

When the launcher exits before writing a launch record, as it does when it refuses its release, there is no journal to explain the stop. The gate then reports the launcher's own last error code, for example `Community live gate failed (published-launcher): launcher exited with COMMUNITY_RELEASE_INVALID before writing a launch record`. Only the code is shown, from the last `Community setup failed:` line, and only when this checkout knows it. When a journal exists, its saved error, which also names the service, is reported instead.

What a tarball receipt can prove is set per decision. For DOR-2238's provenance gate flip, it is acceptable evidence: the marker round trip is how Fly and Neon behave, not something a release changes. That holds provided the cited receipt records `source.kind: 'tarball'` with its `sha256` and `commit`, and that commit is on `main` or on the pull request being proven (see `specs/launcher-uncertain-create-cleanup/02-specification.md`, Implementation phases).

A tarball packed from a release tag plus cherry-picks names a commit that is on neither: cherry-picking gives new commit ids. To cite such a receipt, the flip PR shows that `git log v<version>..<commit>` holds only cherry-picks of commits on `main` or on the pull request being proven. `git cherry <that branch> <commit>` must mark every one of them `-`, meaning the same change is already there. It also names the tag the tarball was packed from.

The implementation received independent REVIEW.md reviews, including the recovery and rotation fixes. The final local evidence is recorded in the PR. A successful local unit run does not establish a successful provider deployment. Task 4.3 remains open until a real published-release run produces its nonsecret deployment, owner, attachment and cleanup receipt.
