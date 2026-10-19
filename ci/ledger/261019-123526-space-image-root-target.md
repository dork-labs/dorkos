---
id: 261019-123526
title: The space image is the root Dockerfile's space target, and installs no machine store
kind: hygiene
status: proposed
actor: agent
gates: [wf.publish-community.build-and-publish, wf.test.community-packaged]
prs: []
ratchet-release: []
field-changes: []
---

Server-merge step 7f (DOR-3010) builds the space image from the repository's
root `Dockerfile`, as two new stages, `space-build` and `space`, placed before
`runtime` so a bare `docker build .` still builds the DorkOS image.
`apps/community/Dockerfile` and its ignore file are gone; the root
`.dockerignore` gains their allow-list. `publish-community.yml` builds
`file: ./Dockerfile`, `target: space`; its file name, the image name, the
release manifest and the migration compatibility id are unchanged. The image
census (`image.baseline.json`) is byte-identical.

The space package's `pnpm deploy` installed `better-sqlite3` (and its types)
as an optional peer of `drizzle-orm` that the workspace resolves. The space
server never loads it. `scripts/space-image/runtime-packages.mjs` now prunes it
right after the deploy, in the release stage and in the acceptance image, and
fails the build if the machine store, a runtime SDK, the terminal, ngrok or
the DorkOS server is installed. The packaged-scope rule now also covers the
root `Dockerfile`, `.dockerignore` and `scripts/space-image/`, so a change to
the DorkOS image's stages also runs the packaged proof: over-inclusive on
purpose.

Hygiene, not an experiment: no gate timing or catch rate should move. Revert
only together with moving the image back to its own Dockerfile.
