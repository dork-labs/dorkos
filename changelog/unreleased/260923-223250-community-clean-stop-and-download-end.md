---
covers:
  - 'fix(community): stop cleanly when told twice, and end a finished download without a reset'
  - 'fix(community): stop within seconds while channels are open, and force it on a second signal'
---

### Fixed

- A self-hosted community server now shuts down cleanly when it is told to stop twice, for example when you press Ctrl-C and your process manager sends its own stop signal too. Before, the second request crashed the shutdown, so the server exited with an error and printed a stack trace even though nothing was wrong. It also stops within about five seconds when people have channels open, instead of waiting for them to leave, and a second Ctrl-C while it is stopping ends it at once (DOR-2221).
- A file or data export that finished downloading no longer breaks the next request if your access to its channel ended at that moment. The download was already complete, but the community cut the connection afterwards, so whatever the app or browser sent next on it failed. You still can't download any more of a file once your access has ended (DOR-2250).
