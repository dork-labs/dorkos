---
id: 261019-110109
title: The space's web pages build from apps/client; the gates see them there
kind: hygiene
status: proposed
actor: agent
gates:
  [wf.test.test-shard, wf.test.community-pg, wf.test.community-packaged, wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

Server-merge step 7e (DOR-3009) moves the space's web pages, as pure renames,
from `apps/community/src/browser/` to `apps/client/src/space/`. They build with
their own config, `apps/client/vite.space.config.ts`, into the same
`apps/community/dist/` the space server and its image serve, so the image is
unchanged. The app's own build, the CLI and the desktop app don't include them.

What the pipeline sees:

- The page's 29 test files run in the `client` vitest project. The 15 that ran
  in Node before keep a `@vitest-environment node` docblock.
- `ci/space-server.env` now names `SPACE_WEB_DIR=apps/client/src/space`, so the
  packaged-scope rule and the vocabulary gate follow. The scope rule also lists
  `apps/client/vite.space.config.ts`, the page's build.
- `check-copy-length.ts` skips `apps/client/src/space/`: the 15-word cap is for
  copy the app renders, and the space is its own website.
- Turbo inputs that named `apps/community/src/browser/**` name the new folder.
- The tenancy receipt's unit runner accepts `apps/client` test files.

Hygiene, not an experiment: no gate timing or catch rate should move. Revert
with the move.
