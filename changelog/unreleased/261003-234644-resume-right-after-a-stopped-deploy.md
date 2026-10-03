---
covers:
  - 'fix(cli): let setup resume right after an interrupted deploy (DOR-2702)'
---

### Fixed

- If you press Control-C while `dorkos community deploy` is deploying your space server, you can now run the resume command it prints straight away. Fly keeps the server locked for a few minutes after a stopped deploy, so setup now says it is waiting and carries on when Fly lets go, instead of failing after a minute and a half. When setup stops, its last line is now plain words that match what it saved, never a code like `CREATION_OUTCOME_UNCERTAIN`. The recovery list also names the storage bucket by its name and reminds you that its Tigris access key outlives the bucket (DOR-2702)
