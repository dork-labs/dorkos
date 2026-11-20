---
covers:
  - 'feat(auth): Wi-Fi sign-in by a one-time code from this computer, and owner passkeys and authenticator codes (DOR-4744, DOR-3647)'
  - 'feat(auth): app screens for Wi-Fi sign-in codes, device approval and sign-in checks (DOR-4744, DOR-3647)'
  - 'fix(auth): review fixes and final copy for Wi-Fi sign-in and sign-in checks (DOR-4744, DOR-3647)'
  - 'fix(auth): the second step reads every sign-in body it lets through (DOR-3647)'
---

### Added

- **Sign in on Wi-Fi with a code.** A phone or laptop on your Wi-Fi now signs in with a short code you approve on the computer DorkOS runs on, instead of your password. Check the code on both screens, approve with a passkey, then type the one-time code on the device. Wi-Fi sign-ins also end after 12 hours unused.
- **Choose which Wi-Fi devices run your agents.** Each Wi-Fi device starts at the safer level. Turn on **Run agents from this device** for one device, on the computer DorkOS runs on. It turns off by itself after 12 hours unused.
- **A second step for other devices.** Add a passkey or an authenticator app in **Settings → Login & security**. Then signing in from another device needs it too. The computer DorkOS runs on never asks, so you can always get back in there.
