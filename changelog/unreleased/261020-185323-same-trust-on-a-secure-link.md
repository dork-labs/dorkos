---
covers:
  - 'fix: review findings: scoped sign-out stop, OAuth returns, per-route account limit, last XFP (DOR-3172)'
---

### Changed

- Signed in on your phone or laptop over remote access or your own tunnel, you can now do everything you can at your desk: change remote access, the password, trusted package sources and the session relay, and sign your other devices out. Plain Wi-Fi keeps its lower level for now, because anyone on the same network could copy that sign-in.
- Signing a device out now also stops the chat turn it started and removes the messages it had waiting to send. Anything started at your desk keeps going.
- A sign-in on another device now ends after 90 days, however often you use it. Sign-ins at your desk are unchanged.

### Security

- Too many wrong passwords for one account now pause sign-ins to it for a few minutes, whichever addresses they come from.
- The sign-in cookie can no longer be sent by another website, even through a link.
