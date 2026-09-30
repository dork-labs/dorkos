---
covers:
  - 'feat(shared): add the managed error-body schema and operation display hints (DOR-2622)'
  - "fix(server): read the managed cloud's real error field and log each refusal once (DOR-2622)"
  - 'fix(server): answer every managed-cloud refusal with an honest status and code (DOR-2622)'
  - "fix(server): name the cloud's code and status at every log site that swallowed it (DOR-2622)"
  - 'fix(site): map managed discovery onto the strict wire field by field (DOR-2622)'
  - 'fix(client): say where a DorkOS account problem is and offer the one fix (DOR-2622)'
---

### Fixed

- When an app connected through your DorkOS account can't load, the app now says where the problem is. It tells you whether DorkOS's servers aren't answering, or whether this computer needs to be linked to your account again, and offers a button to do that (DOR-2622).
- Linking a computer again after its DorkOS account link needed updating now works. Before, the app never recognized the message DorkOS's servers send for that case (DOR-2622).
- Listing an app's actions through a DorkOS account no longer fails when the app sends extra details, such as a logo, a description or a display name for an action. Gmail was one of the apps this hit (DOR-2622).
