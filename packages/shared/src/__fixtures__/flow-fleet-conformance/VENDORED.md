# flow's fleet conformance fixture (vendored)

Every file in this folder except this one and `SOURCE.json` is a byte-for-byte
copy of `plugins/flow/conformance/fleet/` in `dork-labs/marketplace`, at the
commit `SOURCE.json` names. `README.md` is flow's own description of the cases.

It is the shared contract for accounts and usage ledgers that flow and DorkOS
both implement (marketplace `specs/flow-cli-core` §1). DorkOS runs its own code
against it in two suites:

- `packages/shared/src/__tests__/account-usage.conformance.test.ts`: ids,
  identity rows, window reads, ledger merges, Codex rate limits, eligibility,
  and the ledger JSON Schema against `UsageLedgerSchema`. It also fails when the
  contract major is not the one DorkOS implements, or when a case file has no
  runner and no named skip.
- `apps/server/src/services/core/usage/__tests__/fleet-conformance.test.ts`:
  the account list with each runtime's `default`, prune, and the
  `flow-state.json` reader.

## 4.2.0 is proposed here first

`project-eligibility.cases.json`, its README section and `CONTRACT_VERSION`
4.2.0 were written in this repo as the contract-first proposal for account
eligibility (spec `flow-multiproject` §8.7, DOR-2526). Every other file is
still byte-for-byte the marketplace commit `SOURCE.json` names (4.1.0). flow
adopts these cases upstream in F4 (DOR-2532); the next re-sync from a
marketplace commit that carries them replaces this proposal and `SOURCE.json`'s
`proposed` note.

## Re-syncing

Never edit these files by hand. From the repo root:

```bash
pnpm exec tsx scripts/sync-flow-conformance.ts --from <marketplace checkout> --commit <sha>
```

A re-sync is a contract change. Review it in both repos: read the marketplace
diff and the spec revision it carries, change DorkOS until every case passes,
and update `specs/claude-account-fleet` where it restates the contract. Prettier
skips this folder (`.prettierignore`) so the copy stays identical to its source.
