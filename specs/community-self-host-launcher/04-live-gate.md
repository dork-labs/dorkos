# Credentialed launcher acceptance gate

Refs DOR-2169, task 4.3. Status: implemented and locally tested; the actual provider run remains outstanding.

`pnpm --filter dorkos test:community-live` installs an exact published version, refuses a release without the launcher, and runs that installed CLI against explicitly designated disposable Fly, Neon and Tigris resources. It interrupts and resumes owner setup, checks the applied bootstrap-secret rotation, signs in through the public HTTP contract, posts and downloads a private attachment, and verifies anonymous denial. Secrets stay in private temporary files or memory; the clipboard handoff uses a private local socket.

The gate requires every `DORKOS_COMMUNITY_LIVE_*` arm, an exact published version (or an unreleased tarball, below), provider organization and region, charge acknowledgement, and operator-designated budget before it may start. The budget is recorded, not a provider-enforced billing cap. Ordinary verification and CI do not receive these variables. No production origin is accepted by the HTTP proof.

Cleanup verifies recorded provider identities before deleting the disposable resources. If failure leaves resources behind, it preserves the deployment journal and prints a recovery command using the exact published `npx` package, with an explicitly quoted `DORK_HOME`, which remains usable after the temporary install is removed. Successful nonsecret receipts are written outside both cleanup directories. An execution regression runs that command through an executable package-manager stand-in after removing a disposable installation and verifies its exact arguments and ability to read a retained fixture journal. This proves command durability; it is not a full provider-failure cleanup rehearsal.

## Unreleased tarball mode

A launcher fix used to need a release before the gate could try it against the real services. The gate can instead install an unreleased package tarball. Set `DORKOS_COMMUNITY_LIVE_PACKAGE_TARBALL` to the tarball's absolute path **instead of** `DORKOS_COMMUNITY_LIVE_VERSION`. Setting both, or neither, is refused. Every arm, the charge acknowledgement and the budget are still required, and nothing about the run changes except where the launcher comes from.

Pack it from a clean checkout at the commit you want to test:

```sh
git worktree add /tmp/dorkos-pack <commit>
cd /tmp/dorkos-pack
pnpm install --frozen-lockfile
pnpm --filter dorkos pack:community-live -- --out /absolute/output/directory
```

`scripts/pack-community-live-tarball.ts` refuses a checkout with uncommitted changes, both before packing and after the build. It builds the CLI with `pnpm --filter dorkos build` and packs it with `pnpm pack`, which rewrites workspace dependency ranges the way publishing does and `npm pack` would not. Beside the tarball it writes `<tarball>.provenance.json`, which records the commit, the package version and the tarball's sha256.

Before running any process, the gate checks four things. The tarball must be a regular file, not a link. Its sidecar must be complete and say the checkout was clean. The file's sha256 must match the sidecar's. The tarball's `package/package.json` must be `dorkos` at the sidecar's version. Only then does it skip the npm "is it published" check and run `npm install` on that file into its private prefix. The receipt's `source` block reads `{ kind: 'tarball', released: false, file, sha256, commit, packageVersion }`; a published run records `{ kind: 'release', released: true, version }`. The recovery command installs from the same path with `npx --package`, so keep the tarball and its sidecar in place until any resources a failed run left behind are cleaned up.

The tarball replaces only the launcher. It still deploys the published Community image and signed release manifest for the package's own version, so that version must already be released, which is true of any checkout after its release commit. A tarball run is evidence about unreleased launcher code, never about a release.

The implementation received independent REVIEW.md reviews, including the recovery and rotation fixes. The final local evidence is recorded in the PR. A successful local unit run does not establish a successful provider deployment. Task 4.3 remains open until a real published-release run produces its nonsecret deployment, owner, attachment and cleanup receipt.
