# Credentialed launcher acceptance gate

Refs DOR-2169, task 4.3. Status: implemented and locally tested; the actual provider run remains outstanding.

`pnpm --filter dorkos test:community-live` installs an exact published version, refuses a release without the launcher, and runs that installed CLI against explicitly designated disposable Fly, Neon and Tigris resources. It interrupts and resumes owner setup, checks the applied bootstrap-secret rotation, signs in through the public HTTP contract, posts and downloads a private attachment, and verifies anonymous denial. Secrets stay in private temporary files or memory; the clipboard handoff uses a private local socket.

The gate requires every `DORKOS_COMMUNITY_LIVE_*` arm, exact published version, provider organization and region, charge acknowledgement, and operator-designated budget before it may start. The budget is recorded, not a provider-enforced billing cap. Ordinary verification and CI do not receive these variables. No production origin is accepted by the HTTP proof.

Cleanup verifies recorded provider identities before deleting the disposable resources. If failure leaves resources behind, it preserves the deployment journal and prints a recovery command using the exact published `npx` package, with an explicitly quoted `DORK_HOME`, which remains usable after the temporary install is removed. Successful nonsecret receipts are written outside both cleanup directories. An execution regression runs that command through an executable package-manager stand-in after removing a disposable installation and verifies its exact arguments and ability to read a retained fixture journal. This proves command durability; it is not a full provider-failure cleanup rehearsal.

The implementation received independent REVIEW.md reviews, including the recovery and rotation fixes. The final local evidence is recorded in the PR. A successful local unit run does not establish a successful provider deployment. Task 4.3 remains open until a real published-release run produces its nonsecret deployment, owner, attachment and cleanup receipt.
