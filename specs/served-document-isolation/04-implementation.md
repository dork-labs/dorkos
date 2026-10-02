# Served-document isolation implementation

**Status:** Implementation verified; independent review and delivery pending.
**Issue:** DOR-2663
**Workspace:** `/Users/doriancollier/.codex/worktrees/5fa3/dorkos`
**Branch:** `codex/served-document-isolation`
**Worker:** `/root/serve_isolation_implementation` (GPT-6.1 Sol, Medium, explicit human override).

Parent coordinates tracker, commit, push, independent review, PR and merge. This worker owns product/test/artifact edits only. Existing programme/preflight artifacts remain parent-owned. The scoped claim and workspace authorization were supplied by the parent; this worker did not perform tracker writes.

## Evidence

- Before the source fix, `pnpm vitest run apps/server/src/routes/__tests__/workbench-serve.test.ts`: 6 new failures, 18 existing passes, missing CSP.
- Before the source fix, `pnpm --filter @dorkos/e2e exec playwright test --config served-document-isolation.config.ts`: 3 intended failures, 1 compatibility control passed. Direct HTML returned the synthetic secret for GET/POST and read cookie/storage/opener; direct SVG returned the secret; unrelated frame was allowed. The real shim control passed after the fixture acknowledged its hello message.
- After the source fix, same header command: 24 tests passed.
- After the source fix, same Chromium command: 4 tests passed. HTML records exactly GET and POST ingress attempts with no cookie; write count stays at the successful app-control value of one. SVG records one denied read attempt. App and desktop framing load relative assets and receive actual shim console capture. Untrusted framing becomes Chromium's error document.
- `pnpm --filter @dorkos/e2e exec playwright test tests/workbench/served-document-isolation.spec.ts --list --project=chromium`: all four permanent tests listed by normal config.
- Fresh `pnpm --filter @dorkos/server typecheck` and `pnpm --filter @dorkos/e2e typecheck`: exit 0.
- `pnpm vitest run apps/server/src/services/workbench-serve/__tests__/ apps/server/src/routes/__tests__/workbench-serve.test.ts`: 132 tests passed across six files.
- Scoped e2e ESLint: exit 0, no warnings. Full e2e package lint: exit 0, 24 existing warnings.
- Changed-file Prettier check and `git diff --check`: exit 0.
- Server and e2e package lint: exit 0 with pre-existing warnings (server 113, e2e 24 excluding fixture env access now explicitly scoped).

Initial test collection failed on absent extension-api/harness/relay builds. `pnpm exec turbo run build --filter '@dorkos/server^...'` rebuilt 12 dependency build tasks successfully, after which actual tests collected. These startup failures are not red-regression evidence.

## Policy and boundaries

The serve handler emits sandbox and frame-ancestors before token/path validation, so both files and error responses receive the policy. It retains script/form/popup/modal behavior and omits same-origin. `frame-ancestors 'self'` permits the actual response origin; the concrete `resolveAuthTrustedOrigins()` list permits supported Vite, desktop and tunnel app origins. The resolver excludes malformed/opaque/wildcard configured origins. A stricter X-Frame-Options SAMEORIGIN would contradict supported desktop development framing and is deliberately absent.

The e2e fixture uses full createApp middleware, a TestModeRuntime, OS-assigned listeners, a temporary home, synthetic endpoint handlers and synthetic cookies. Late dynamic source loading avoids changing any server declaration types solely for a browser fixture. Express and its types are fixture dev dependencies in e2e; the lock diff is confined to its importer. The fast config points to the exact permanent spec and does not replace normal merge-queue discovery.

No actual tunnel account was connected. Tunnel coverage is response-policy coverage. The tests prove origin isolation, not bridge-report authenticity or arbitrary network isolation.

## Resume

Done: intended red baseline, bounded response fix, initial green browser/header verification, normal discovery proof.
Next: parent runs independent adversarial review of the actual diff, then owns delivery.
Open: independent adversarial review, commit/push/PR/merge remain parent-owned and unperformed.
Next command: `pnpm --filter @dorkos/e2e exec playwright test --config served-document-isolation.config.ts`.

## Delivery verified

PR2457 merged at2026-10-01T21:55:52Z as d19d3ee73534dc9b69474bedffe9840db74ed931 after exact-head independent review and local/forge gates passed. Flow DONE succeeded; run complete. Project pulse21of27done,6open: skip reason `rollup-incomplete`. Programme worktree/evidence retained for remaining supporting scopes.
