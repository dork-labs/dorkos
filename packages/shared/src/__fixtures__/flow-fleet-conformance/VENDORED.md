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

## Re-syncing

Never edit these files by hand. From the repo root:

```bash
pnpm exec tsx scripts/sync-flow-conformance.ts --from <marketplace checkout> --commit <sha>
```

A re-sync is a contract change. Review it in both repos: read the marketplace
diff and the spec revision it carries, change DorkOS until every case passes,
and update `specs/claude-account-fleet` where it restates the contract. Prettier
skips this folder (`.prettierignore`) so the copy stays identical to its source.
