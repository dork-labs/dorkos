---
covers:
  - 'feat(api): eight reads about this computer move onto the capability mount (DOR-4978)'
  - 'fix(api): an unexpected git status failure answers and logs as the hand route did (DOR-4978)'
---

### Changed

- Eight reads about this computer are now listed in the API document: what each agent program needs, which memory store is in use, the shell check, keep-awake, a folder's git status, an OpenRouter sign-in's progress, and two diagnostic reads. Most were missing from the document before. Their addresses and answers are the same, and so is who may read them.
- From another program on this computer that sends a key, the OpenRouter sign-in progress now answers that it is only for this computer, as the other runtime settings already do.
- In the API document, the keep-awake read has a new operation name: `keepAwake.get` is now `keep-awake.status`. A generated client needs regenerating.
