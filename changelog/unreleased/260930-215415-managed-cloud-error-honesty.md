---
covers:
  - 'feat(shared): add the managed error-body schema and operation display hints (DOR-2622)'
  - "fix(server): read the managed cloud's real error field and log each refusal once (DOR-2622)"
  - 'fix(server): answer every managed-cloud refusal with an honest status and code (DOR-2622)'
  - "fix(server): name the cloud's code and status at every log site that swallowed it (DOR-2622)"
  - 'fix(site): map managed discovery onto the strict wire field by field (DOR-2622)'
  - 'fix(client): say where a DorkOS account problem is and offer the one fix (DOR-2622)'
  - 'fix(client): let a linked computer link again, one click from the error (DOR-2622)'
  - 'fix(client): give the app actions list the same named problem and relink (DOR-2622)'
  - 'fix(server): answer a DorkOS account refusal on event routes honestly (DOR-2622)'
  - 'fix(server): read a refusal body bounded and field by field (DOR-2622)'
  - 'fix(server): name the cloud code and status when managed recovery fails (DOR-2622)'
  - 'fix(site): cap an upstream version reason at the wire limit (DOR-2622)'
---

### Fixed

- When an app connected through your DorkOS account can't load, the app now says where the problem is. It tells you whether DorkOS's servers aren't answering, or whether this computer needs to be linked to your account again (DOR-2622).
- When the link needs to be made again, a "Link my DorkOS account again" button opens Settings and starts a new link for you. Your computer stays linked until you approve the new one (DOR-2622).
- A computer whose DorkOS account link needed updating can now pick up the update by linking again. Before, the app never recognized the message DorkOS's servers send for that case, and a linked computer had no way to link again (DOR-2622).
- Listing an app's actions through a DorkOS account no longer fails when the app sends extra details, such as a logo, a description or a display name for an action. Gmail was one of the apps this hit (DOR-2622).
