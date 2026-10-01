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
  - "fix(cloud-link): keep a linked computer linked when a relink doesn't finish (DOR-2622)"
  - "fix(connectors): keep the provider error's cause when discovery wraps it (DOR-2622)"
  - 'fix(cloud-link): never throw away a key the cloud issued at token exchange (DOR-2622)'
  - 'fix(cloud-link): withdraw before draining, bound the token request, nothing after stop (DOR-2622)'
  - 'fix(cloud-link): bound the token response body as well as its headers (DOR-2622)'
---

### Fixed

- When an app connected through your DorkOS account can't load, the app now says where the problem is. It tells you whether DorkOS's servers aren't answering, or whether this computer needs to be linked to your account again (DOR-2622).
- When the link needs to be made again, a "Link my DorkOS account again" button opens Settings and starts a new link for you. Your computer stays linked until you approve the new one (DOR-2622).
- A computer whose DorkOS account link needed updating can now pick up the update by linking again. Before, the app never recognized the message DorkOS's servers send for that case, and a linked computer had no way to link again (DOR-2622).
- If a new link is turned down, its code times out, or it can't finish, Settings keeps showing this computer as linked, with a short note you can dismiss. Before, it showed an error until the next check, up to 15 minutes later. You can also cancel a new link while its code is showing. If the new link finishes at the moment you cancel, it is kept rather than lost, and Settings shows this computer as linked (DOR-2622).
- The dorkos.ai fallback that lists apps and their actions for a DorkOS account no longer fails the whole list when an app sends extra details, such as a logo or an action's display name. It now leaves those details out (DOR-2622).
