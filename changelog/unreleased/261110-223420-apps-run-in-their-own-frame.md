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
  - 'feat(extensions): the approval card lists the other apps an app uses, and a new one asks again (DOR-3293)'
  - "feat(extensions): the approval card says what an app's screens can change, in DorkOS's words (DOR-3293)"
  - 'feat(extensions): a target that starts sharing more asks again, and "shares nothing" reads plainly (DOR-3293)'
  - 'fix(extensions): "It can change:" reads the one table the bridge and the server enforce, and says when it can change nothing (DOR-3293)'
  - "fix(extensions): approvals never say screens run with your access, and an app page's canvas opens beside it (DOR-3293)"
  - "fix(extensions): an app that names another app by anything but its id can't be installed or updated (DOR-3293)"
  - 'fix(marketplace): a refused package names itself as its title does and offers only Close (DOR-3293)'
  - "fix(extensions): an app's canvas widget may only link out, and a trusted app asks again when its screens reach further (DOR-3293)"
  - 'fix(canvas): a document an app opened can never hold a widget action other than a link, on any write (DOR-3293)'
  - "fix(canvas): check the document as it will end up on every update, so a mark-only patch can't label an agent widget as an app's (DOR-3293)"
  - 'fix(extensions): an app page whose root is height:100% fills its frame instead of drawing blank (DOR-3293)'
  - 'fix(extensions): an app page taller than its slot scrolls inside its frame (DOR-3293)'
  - 'fix(extensions): a dev-linked app page shows one scrollbar, its frame taking only the height under the strip (DOR-3293)'
---

### Security

- Each app's screens now run in a sealed-off frame of their own. An app can no longer see your sign-in or the rest of the DorkOS window, and it reaches DorkOS only through the actions DorkOS lets it use (DOR-3293).
- **Apps built for an older version of DorkOS need a rebuild before they run again.** This includes apps other people made. Until then, the app shows that it needs an update, and none of its code runs. If you build apps, the [update guide](/docs/integrations/extension-frame-migration) lists the few changes: add `"clientApiVersion": 2` to the app's `extension.json`, and call your app's own server through `api.request` instead of `fetch`. Apps made by your agents from now on are built the new way.
