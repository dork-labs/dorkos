---
covers:
  - 'fix(cli): let setup resume right after an interrupted deploy (DOR-2702)'
---

### Fixed

- If you press Control-C while `dorkos community deploy` is deploying your space server, you can now run the resume command it prints straight away. Fly keeps the server's Machine locked for a few minutes after a stopped deploy, so setup now says it is waiting and carries on when Fly lets go, instead of failing after a minute and a half. A setup stopped this way now ends with a plain line that matches what it saved and says how to carry on. When a change on Fly, Neon or Tigris fails, setup now explains it in plain words instead of a code like `CREATION_OUTCOME_UNCERTAIN`, and saves the code with its progress. The recovery list also names the storage bucket by its name and reminds you that its Tigris access key outlives the bucket (DOR-2702)
