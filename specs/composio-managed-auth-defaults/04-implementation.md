# DOR-1958 implementation

## Session

Author worktree: `codex-composio-managed-auth-defaults`; branch `codex/composio-managed-auth-defaults`; pinned base `57171c402690bc82b3166ae057e75d6c599ed3d8`. Root coordinates separate Track B and live operations. No production action is part of this implementation.

## Completed common contract (1.1)

Common commit `209e478f74b7e78995e464332dea232af0acc157` preserves all 31 independently reviewed source blobs. The post-commit hook added one changelog seed, now consolidated into the curated entry for the complete feature. Independent REVIEW.md PASS0 report SHA `103a1b35d4e9e833a8bb065e12a98c932cd2b34cb838e80cc5850b3940ad6e14`; independent 80/80 focused checks. Author 80/80, all five affected package types, and ordinary format/lint/typecheck hooks passed. Exact negotiated v1/header/cache/pagination/legacy behavior and hosted form interfaces are frozen in ignored common checkpoint 1.

## Track A resolver (2.1): independently verified

Exact selected-toolkit metadata and configuration identity now drive custom precedence, managed OAuth defaults and supported field schemes. The durable resolver permits one fresh config-create claimant and reconciles unknown outcomes through complete exact-name reads without repeating creation. New automatic config IDs remain outside the existing provider material digest; existing explicit mappings retain precedence and authority. Migration 0016 adds the resolver and flow descriptor metadata, preserving existing rows as OAuth flows. Start requests record their resolved method before any account create; field and no-auth flows wait for owner completion without an upstream account create.

Node 24 checks: the four-file resolver/SDK/full authority lifecycle cohort passed 73/73; provider and site types passed. Three narrow mutants failed the intended assertions (repeat unknown create, bypass custom precedence, discard field constraints), source hashes restored exactly, and restored controls passed 3/3. The final unused test-parameter correction passed the full 14-case resolver file, site types and ESLint. Changed-file lint has no remaining errors or warnings. Earlier failed setup/wire expectation logs are retained in the ignored Track A evidence bundle.

Checkpoint 2 closes both independent findings: automatic configurations now require the exact nonsecret scope/credential/tool/proxy policy, and list requests honor the documented maximum of 50. Independent REVIEW.md PASS0 report SHA `d0ca356148e093d451cd330d0d4524aa5dc9ecbb8b3e0702df9c2dbb1b555e32` verifies all 48 frozen blobs and both patch reconstructions at tree `36621fac93cafcde4fe1337ca4dbf3cf617b887f`. Independent Node 24 checks passed 44/44 plus the material-preservation control. Author policy-guard mutant failed both ready and unknown-create controls, then exact restoration passed. No live upstream call was made.

## Track A owner completion (2.2): independently verified

The owner service and same-origin credential POST are implemented in the author tree, separately from the frozen resolver checkpoint. The page remains read-only, the cookie expires within the remaining flow lifetime, and completion consumes the flow before one upstream account create. Prepared tests cover owner/cookie/Origin/CSRF/metadata/material fences, bounded request streaming, expiry, concurrent submissions, lost results, and OAuth mode separation. The cross-service oracle completes a newly resolved account without an explicit map, grants and executes an action through existing authority, then adds another toolkit and checks the original account and grant remain usable. Node 24 site typecheck and changed-file ESLint passed. The four-file owner, route, OAuth-browser and existing authority cohort passed 67/67. Three meaningful mutants failed their intended assertions: removing the consume CAS dispatched two creates; removing the OAuth-mode fence called the OAuth redeemer for a waiting no-auth flow; removing the actual streamed-byte bound accepted oversized valid JSON. Exact source restoration was verified and the three focused controls passed again. This is synthetic proof only.

Checkpoint 4 closes the independent recovery finding: if the first database write after successful upstream creation fails, one guarded catch write retains the exact returned account ID for reconciliation. Throw and empty-write regressions traverse the real later reconciliation path with no second create; a continuing database outage stays uncertain without fabricated durability. Independent REVIEW.md PASS0 report SHA `63f11a9ed98ae8ea2d2ab70c28d7e8244aa1c40ed2bab062db17e8cdcfa34df9` verifies all 55 frozen paths, both patch reconstructions at tree `f1bef1fa15c5c32e895e69222d95560d7ad30bcb`, and 24/24 owner tests. Author restored recovery controls passed after killing the known-ID omission mutant.

## Track B and final composition (2.3 / 3.1)

Track B source checkpoint 4 and browser checkpoint 5 passed independent review (report SHA `2c3e578ecbc4aeb2351e1651033e2d499dec321743dd94520d79f580613dd79b`). Its common-relative patch was applied with all 17 paths exactly matching tree `fdf255ca36f33357331c4da15e34643fa12d892c`. The accepted browser evidence covers representative local and hosted states, mobile and desktop, keyboard use, and accessibility checks. The operator catalog now bounds its 1,000-row UI request to the managed wire's 100-row page maximum.

The pending DOR-1905 security guidance is composed without changing its live verdict. Four nonoverlapping documentation changes were carried forward; the three setup-guide overlaps preserve Track B's current managed-default and hosted credential custody semantics. Historical September 9 source/deployment evidence is explicitly dated rather than described as current. The API request envelope is 72 KiB; the enclosed fields object remains limited to 64 KiB.

Final integration main is pinned once at `6a466dd7387eb0da9eda5628250637ec4dfc2c25`. The original author base remains `57171c402690bc82b3166ae057e75d6c599ed3d8`; final source composition and merge compatibility are checked against the pinned target.

## Final local verification

All implementation tasks are complete. The composed five-file cohort passed 73/73; the ordinary OpenAPI export and site API documentation generation passed against pinned main. Independent final source review accepted the main union and scoped vocabulary entries. The normal gate exposed two stale hosted test fixtures: the optional map expectation and a mounted account fake missing the real resolver's metadata methods. The corrected fixtures preserve the real resolver, migration 0016, owner/instance authority and denial assertions. Independent checkpoint 4 PASS0 (report SHA `35db23d38dca106e7d06d4633d3b06c792451f132a1edded81e1542c6b30391f`) verifies the exact 78-path candidate and 7/7 focused tests. Earlier failed runs remain in the public verification evidence.

A later full server run observed 31 unexpected 401 responses in the unchanged agent-creation fixture. Its 23 captured route, transport, schema and runner inputs match pinned main, and the same unmodified file passed 31/31 in isolation. The aggregate response origin remains unproven; no auth, assertion or transport change was made. The single subsequent unchanged ordinary `pnpm verify` passed, including script tests, root lint, affected type/lint checks and affected package tests. The hosted suite passed all 1,208 tests and the client suite reused its successful 14,817-test cache entry. The final ordinary `turbo run build --filter=@dorkos/site --concurrency=2` passed against the composed source using a credential-free build environment. No local database migration ran. These local results do not represent deployed or live-account proof.

## Publication and live gates

Normal commit/push hooks, independent verification of the actual remote source, PR review and required CI/merge-queue checks remain publication gates. The recovery branch is preserved; the final single-commit branch will use pinned main `6a466dd7387eb0da9eda5628250637ec4dfc2c25`. Completing the implementation task list does not claim those later gates passed.

DOR-1905 live acceptance remains separate and pending. Root owns production deployment, migration 0016 and any deliberate change to the temporary Gmail override after checking its existing authority impact. No production migration, account consent or provider action has been performed by this implementation.
