---
covers:
  - 'fix(server,shared): saving settings no longer sends your secret keys back (DOR-1740)'
---

### Fixed

- Fixed a bug where saving any setting sent your stored secrets back over the wire: the reply carried your ngrok token, your tunnel sign-in, your MCP key and your cloud token in plain text, even when the setting you changed had nothing to do with them. Replies like that get written to logs and browser caches, and they travel the public internet when you use DorkOS from your phone. Saving now replies with a curated summary that says whether a key is set without saying what it is (DOR-1740)
