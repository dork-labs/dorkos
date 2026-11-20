---
covers:
  - 'feat(auth): Wi-Fi sign-in by a one-time code from this computer, and owner passkeys and authenticator codes (DOR-4744, DOR-3647)'
  - 'feat(auth): app screens for Wi-Fi sign-in codes, device approval and sign-in checks (DOR-4744, DOR-3647)'
  - 'fix(auth): review fixes and final copy for Wi-Fi sign-in and sign-in checks (DOR-4744, DOR-3647)'
  - 'fix(auth): the second step reads every sign-in body it lets through (DOR-3647)'
  - "fix(auth): use the app's word for a sign-in on the Wi-Fi warning (DOR-4744)"
  - 'fix(auth): every Wi-Fi sign-in from before the code sign-in signs in again (DOR-4744)'
  - 'test(server): list the sign-in and sign-in check routes in the route censuses (DOR-4744, DOR-3647)'
  - 'docs(changelog): every Wi-Fi device signs in again after updating (DOR-4744)'
  - 'fix(auth): sign-in checks change only at this computer, and stay required once set (DOR-3647, DOR-4744)'
  - 'fix(auth): the first sign-in check from other devices ends earlier sign-ins before it counts (DOR-3647)'
  - 'fix(auth): removing the last sign-in check says other devices wait for a new one (DOR-3647)'
  - 'fix(auth): a sign-in check counts only once the earlier sign-ins have ended (DOR-3647)'
  - 'fix(auth): taking back an unfinished sign-in check touches only that check (DOR-3647)'
  - 'fix(auth): Wi-Fi device rows fit a phone, and each note sits by what it is about (DOR-4744)'
  - 'fix(auth): one main action on each sign-in screen, and added checks read as a list (DOR-3647, DOR-4744)'
---

### Added

- **Sign in on Wi-Fi with a code.** A phone or laptop on your Wi-Fi now signs in with a short code you approve on the computer DorkOS runs on, instead of your password. Check the code on both screens, approve with a passkey, then type the one-time code on the device. Wi-Fi sign-ins also end after 12 hours unused.
- **Choose which Wi-Fi devices run your agents.** Each Wi-Fi device starts at the safer level. Turn on **Run agents from this device** for one device, on the computer DorkOS runs on. It turns off by itself after 12 hours unused.
- **A second step for other devices.** On the computer DorkOS runs on, add an authenticator app in **Settings → Login & security**. Then signing in from another device needs its code too. You add or remove one only on that computer, and it never asks for the code, so you can always get back in there.

### Changed

- **Wi-Fi devices sign in again after updating.** Every phone or other device signed in over Wi-Fi is signed out once and signs in again with a code. **Run agents from this device** starts off for each of them.
