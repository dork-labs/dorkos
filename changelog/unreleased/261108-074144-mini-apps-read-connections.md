---
covers:
  - 'feat(extensions): a mini app can declare the apps it reads, and a change to that list waits for a person (DOR-3547)'
  - 'feat(connectors): a mini app reads a connected app through DorkOS, with no token and only what a person approved (DOR-3547)'
  - 'refactor(extensions): the lifecycle wires ctx.connections in one line, inside its size limit'
  - "fix(connectors): a mini app reads only on a person's yes, and gets no answer if its access changed while the app replied"
  - 'fix(extensions): only files a person approved by hand let a mini app read a connected app'
  - 'feat(connectors): a mini app reads a connected app through DorkOS, with no token and only what a person approved (#3537)'
  - 'feat(connectors): the Connections page lists what mini apps wait for and may read, and can take a yes back'
  - 'feat(connections): a mini app waiting to read an app shows in Needs you as a link, and each account lists the mini apps that can read it'
  - 'feat(connectors): a person lets a mini app read an app only on its own page, outside the app'
  - 'fix(connectors): the mini app decide page says it is DorkOS, and its labels, buttons and account read cleanly in both themes'
  - 'docs(api): the mini app access list and revoke are in the API reference, and the route census knows the new routes'
---

### Added

- Let a mini app that runs in its own sandbox read from an app you connected, after you approve it once: it never sees a password or token, it can only read, and every read shows under its name (DOR-3547)
