# Extension-seam contract fixture

The host types the flow extension builds against (spec `flow-multiproject` §10.5), declared in `seams.contract.ts` exactly, types only, with its version in `CONTRACT_VERSION` (semver).

- **In this repo**, `src/__tests__/seam-contract.test.ts` checks the real `@dorkos/extension-api` types against these declarations in both directions. It fails when either side changes alone.
- **In the flow extension**, vendor `seams.contract.ts` and `CONTRACT_VERSION` into the plugin and run the same two-way check against `lib/host-types.ts`.

## Changing a seam

1. Change the real type in `src/`.
2. Change `seams.contract.ts` to match, in the same PR.
3. Bump `CONTRACT_VERSION`: minor for an added member, major for a removal or a narrowing.
4. Vendor the new files into flow.

Extensions detect a seam by probing for it (`ctx.projects !== undefined`), never by a host version, so one flow build runs on hosts from before and after each change.
