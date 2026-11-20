# PR #4060 design shots

Taken on head `12927b5304` (the UI has not changed since). Throwaway test-mode server with made-up data. The browser ran in a sealed Playwright container. Network replies were faked for the signed-in, Wi-Fi and request states, and `navigator.credentials` was stubbed, so no passkey ceremony ever ran.

Each screen in `-light` (1280), `-dark` (1280) and `-390` (phone, light).

- A: the device's Wi-Fi sign-in screen with the match code and the code field.
- B: the Mac's sign-in request card, with the same match code above Approve.
- C: after Approve with no passkey on this computer.
- D: the one-time code in 3+3 groups.
- E1: Signed-in devices with two Plain Wi-Fi rows, one switch on.
- E2: the "Run agents from this device" confirm dialog.
- F: passkeys and authenticator apps for signing in from other devices.
- G1: the login screen's second step.
- G2: the authenticator code field.
