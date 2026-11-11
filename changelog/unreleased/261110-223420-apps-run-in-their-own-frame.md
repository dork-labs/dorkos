---
covers:
  - "feat(extensions): each app's screens run in their own sandboxed frame (DOR-3293)"
  - 'feat(extensions): old apps say they need an update; frames size to what they draw; download and canvas through the bridge (DOR-3293)'
  - "feat(extensions): app screens load from DorkOS's own frame page with its own policy (DOR-3293)"
  - "fix(extensions): the frame takes its runtime and setup only from DorkOS's exact origin (DOR-3293)"
  - 'fix(extensions): screen data has its own store; app requests fail with status and body; each path part is encoded (DOR-3293)'
  - "fix(extensions): an app saves a file through DorkOS's own dialog (DOR-3293)"
  - "fix(extensions): a canvas tab an app opened says so, from DorkOS's own record (DOR-3293)"
  - 'fix(server): a canvas "opened by" mark names only a running app, and never comes from an agent (DOR-3293)'
  - 'feat(extensions): apps show pictures and video from their own routes with api.media (DOR-3293)'
  - "feat(extensions): one app can call another's exported routes, when both manifests agree (DOR-3293)"
  - 'fix(server): session routes see their settings live again (DOR-3293)'
  - 'fix(extensions): the server knows the calling app from a per-frame caller token, never a header (DOR-3293)'
  - "fix(extensions): a caller token is minted only for the DorkOS window's own page (DOR-3293)"
---

### Security

- Each app's screens now run in a sealed-off frame of their own. An app can no longer see your sign-in or the rest of the DorkOS window, and it reaches DorkOS only through the actions DorkOS lets it use (DOR-3293).
- **Apps built for an older version of DorkOS need a rebuild before they run again.** This includes apps other people made. Until then, the app shows that it needs an update, and none of its code runs. If you build apps, the [update guide](/docs/integrations/extension-frame-migration) lists the few changes: add `"clientApiVersion": 2` to the app's `extension.json`, and call your app's own server through `api.request` instead of `fetch`. Apps made by your agents from now on are built the new way.
