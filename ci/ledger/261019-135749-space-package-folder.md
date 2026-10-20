---
id: 261019-135749
title: The space server's package folder is apps/space
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.community-pg, wf.test.community-packaged, wf.publish-community.build-and-publish]
prs: []
ratchet-release: []
field-changes: []
---

Server-merge step 7g (DOR-3011) renames `apps/community`, the space server's
remaining package folder, to `apps/space`, as pure renames. It holds the
image's deploy manifest (still `@dorkos/community` 0.1.0, so `/app` is the
same), the migrations, the acceptance proof, the browser tests, the load
harness and the operator guides. The space server's code stays in
`apps/server/src/services/spaces/` and its pages in `apps/client/src/space/`.

What the pipeline sees: `ci/space-server.env` names `SPACE_DIR=apps/space`, so
the packaged-scope rule, the workflows and the scripts follow. Turbo task ids
and `--filter @dorkos/community` are unchanged, and so are the required job
names `community-pg` and `community-packaged`. The vitest project follows its
folder's name, `space`. The root Dockerfile's `space` stages and
`.dockerignore` name the new folder. The launcher's tarball check now compares
migrations by name and content, wherever the folder is, so a release tag from
before the move still matches.

Hygiene, not an experiment: no gate timing or catch rate should move.
