---
covers:
  - 'feat(server): every gate decides by where a request came from, not one switch (DOR-2967 part 1)'
---

### Changed

- DorkOS now checks where each request comes from. On this computer, nothing changes: you are still signed in. From any other device, you always need to sign in, even with "Require login" off (DOR-2967).
- A phone or laptop that reaches DorkOS through your own tunnel or over Wi-Fi no longer counts as "this computer". Signing an agent in to Claude and other setup that only works at the computer now refuses it (DOR-2967).
- If DorkOS runs behind a reverse proxy on the same computer, other devices now need a password. Create your owner account on the computer itself first (DOR-2967).
- Sharing DorkOS beyond this computer now needs only an owner account, not "Require login" (DOR-2967).
- An MCP client on another device now signs in with your personal API key. The local token, and a key set in `MCP_API_KEY`, work only on this computer (DOR-2967).
- A Docker install with no owner account yet stays open, as before, for this release only. A later release will ask for a one-time setup code instead (DOR-2967).
