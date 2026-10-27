---
title: 'Spike: "Confirm it''s you" step-up with passkeys, per surface (DOR-3234)'
date: 2026-10-27
type: spike
status: active
tags: [security, step-up, webauthn, passkeys, electron, tunnel, dor-3234, dor-3212]
---

# Spike: "Confirm it's you" step-up with passkeys, per surface

Checked 2026-10-27 for DOR-3234. That ticket gates the Allow path in DOR-3213, DOR-3214 and DOR-3216, and the paused-connection Confirm button (DOR-3271). This is a spike: no product code changed. The prototypes were throwaway, ran on spare ports with fake ("virtual") authenticators only, and are described under Evidence.

## The answer in one paragraph

Passkeys work in a browser on `http://localhost` and on a phone over HTTPS. They do **not** work on `http://127.0.0.1` or `http://[::1]`. In the desktop app, Touch ID passkeys are possible on our Electron (41.10.7) but need a signing change first. So: build **one server step-up guard with two ways to pass it**. The owner password (from #3212) works on every surface and ships first. Passkeys follow, browser first, then the desktop app. The password alone meets the DOR-3212 threat model ("other programs on this computer, agents included, can't act as you"). So it unblocks the Allow path in about 4 days. Passkeys are a fast follow, not a gate.

## Per surface

| Surface                                                             | Passkey verdict                       | Relying party (RP ID) | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app, `http://localhost:<port>` (Chrome, Safari)                 | **Works**                             | `localhost`           | Prototype: register and sign-in both verified server-side, in Chromium and Electron. Safari's engine sees a secure context with the API present. A real Safari Touch ID run was not done (no real enrolment allowed).                                                                                                                                                       |
| Web app, `http://127.0.0.1` or `http://[::1]`                       | **Doesn't work**                      | none possible         | Prototype: `SecurityError: This is an invalid domain.` for every RP ID. Fallback: password, or "Open DorkOS at localhost to use your passkey."                                                                                                                                                                                                                              |
| Desktop app (Electron 41.10.7, window on `http://localhost:<port>`) | **Works with conditions**             | `localhost`           | The WebAuthn plumbing works (prototype, fake authenticator). Touch ID needs `app.configureWebAuthn({ touchID })`, which exists in our build, plus the `keychain-access-groups` entitlement in the signed app. Passkeys stay on this Mac, unsynced. Without the switch, the app reports no Touch ID (`isUserVerifyingPlatformAuthenticatorAvailable()` = `false`, measured). |
| Desktop app, custom `app://` scheme                                 | **Doesn't work**                      | none                  | Moot: the DorkOS window already loads `http://localhost` (`apps/desktop/src/main/window-manager.ts`).                                                                                                                                                                                                                                                                       |
| Phone over the managed remote address (HTTPS)                       | **Works with conditions**             | the full hostname     | Works while the hostname stays the same. The tunnel's parent domain is on the Public Suffix List, so the RP ID must be the full hostname. A new hostname orphans every passkey made on the old one (prototype).                                                                                                                                                             |
| Phone over the person's own ngrok tunnel (BYO)                      | **Works only with a reserved domain** | the full hostname     | An ephemeral ngrok address changes on each start, which orphans the passkey. Offer the password there.                                                                                                                                                                                                                                                                      |
| Phone or browser, plain HTTP on the LAN                             | **Doesn't work**                      | none                  | Not a secure context, so there is no WebAuthn. Per the Security rules, no password either: "Confirm this on the Mac running DorkOS, or set up a passkey."                                                                                                                                                                                                                   |

### Evidence, one line each

- **localhost is a secure context.** W3C Secure Contexts: an origin is potentially trustworthy if its "host is "localhost" or "localhost."" (https://www.w3.org/TR/secure-contexts/). The loopback IPs are secure contexts too ("127.0.0.0/8 or ::1/128"), but see the next line.
- **An IP can't be an RP ID.** WebAuthn L3: "a relying party identifier is a valid domain string" (https://w3c.github.io/webauthn/). Measured in Chromium 146: `SecurityError: This is an invalid domain.` on `127.0.0.1` and `[::1]`.
- **The RP ID must match the page's domain.** MDN: "The `id` needs to equal the origin's effective domain, or a domain suffix thereof." (https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredentialCreationOptions). Measured: `localhost` asking for `example.com` was refused.
- **Electron has a Touch ID switch, in our version.** The `electron.d.ts` in Electron 41.10.7 says: "Until this is called, `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` resolves to `false` and platform-authenticator requests are not serviced." Also: "Touch ID WebAuthn credentials are device-bound and are not synced via iCloud Keychain." It landed in electron/electron#51255 ("Added `app.configureWebAuthn()` to enable the Touch ID platform authenticator…") and was backported to 41 (#51412). Measured: `typeof app.configureWebAuthn === 'function'` on 41.10.7.
- **iCloud-synced passkeys in Electron need Electron 45.** electron/electron#51563 ("add system passkey support on macOS via `app.configureWebAuthn()`") is labelled `no-backport`. It also needs associated domains and a provisioning profile.
- **Electron shows no browser passkey dialogs.** Only the OS Touch ID sheet appears. Choosing between accounts is the app's job (`select-webauthn-account` session event, #51255). The phone-as-a-key QR flow doesn't start in Electron. Measured log: "FIDO: Cannot use Bluetooth because the responsible app … does not have Bluetooth metadata in its Info.plist."
- **`systemPreferences.promptTouchID` is not a proof.** Electron docs: it "resolves if the user has successfully authenticated with Touch ID" (https://www.electronjs.org/docs/latest/api/system-preferences). That is a local yes/no with nothing signed for the server to check. Rejected as a step-up.
- **Tunnel domains are public suffixes.** The Public Suffix List lists `ngrok-free.app`, `ngrok.app`, `ngrok.dev`, `ngrok.io` and `trycloudflare.com` (https://raw.githubusercontent.com/publicsuffix/list/master/public_suffix_list.dat). So the RP ID can't be the shared parent. Measured with two test hostnames: a passkey made on `abc.<domain>` is refused on `xyz.<domain>`.
- **One RP ID across origins is possible but young.** Related Origin Requests (`/.well-known/webauthn`) need Chrome 128+, Safari on macOS 15+ and Firefox 152+, with a limit of 5 labels (https://passkeys.dev/docs/advanced/related-origins/). It doesn't help `localhost`, which can't serve a shared well-known file for another domain. Not needed for the recommendation.

## What already exists (reuse, don't fork)

- **#3212 (DOR-3330 Stage 1, open):** `checkOwnerPassword` in `services/core/auth/owner-password.ts` and `requirePersonAtThisComputer` in `lib/caller-authority.ts`. It confirms a browser **once**, for 30 days. It does not confirm each action.
- **Relay approvals (`services/core/session-relay/`):** `approval-proof.ts` runs eight checks with `@simplewebauthn/server`. Steps 2 to 7 (pinned key, client data, RP hash with UP+UV, signature, counter, user handle) don't care what the action is. Only step 1 (the statement) and step 8 (still pending) are specific to relay approvals. The key store pins **one https origin** whose RP ID is DorkOS's approve page, and it needs a DorkOS account. That is right for the relay, and wrong for a local step-up, which must work with no account and on `http://localhost`.

## Recommendation

**One design: a per-action step-up guard on the server, passed by a password or a passkey.**

1. **The statement.** Use a new local statement type, `dorkos.local.step-up.v1`: `purpose: 'step-up'`, action kind, target, input hash, nonce, 2-minute expiry, single use. It lives in `packages/shared`, not `cloud-api`, because it never leaves this computer. Keep it separate from the relay's `dorkos.relay.approval.v1`, and each verifier refuses the other's statement. Tests go in both directions, per the Security rules from 10-22.
2. **The guard.** `requireStepUp(action)` in front of the five DOR-3212 actions and DOR-3271's Confirm. Nothing commits until a proof passes. A cancelled, failed or expired step-up writes nothing.
3. **Way 1, the password (ships first).** Re-enter the owner password through `checkOwnerPassword`, bound to that one statement. Allowed on loopback or HTTPS only. 5 tries, then a cooldown, logged to Activity. This is the fallback that never goes away.
4. **Way 2, passkeys (fast follow).** Pull steps 2 to 7 of `approval-proof.ts` into one shared `verifyPasskeyAssertion()` that both the relay and the step-up call. Add a local key store that pins keys **per origin**: `http://localhost:<port>` with RP ID `localhost`, and the managed remote hostname with its own RP ID. When the person opens the page on `127.0.0.1`, offer a link to the `localhost` address of the same page.
5. **Desktop Touch ID (later, its own PR).** Call `app.configureWebAuthn({ touchID: { keychainAccessGroup } })` and add `keychain-access-groups` to `apps/desktop/build/entitlements.mac.plist`. Restricted entitlements may also need an embedded provisioning profile. This must be checked on CI, never on this Mac. Until then the desktop app uses the password.
6. **Order on the card** (designer rule): passkey sheet if one is enrolled for this origin → password field → "Set up a passkey to do this."

**Fallback design** if passkeys slip: the password alone, as in steps 1 to 3. It is complete on its own.

### When the password is enough

- **Enough against the stated threat.** An agent or another program can't type a password it doesn't know. The proof is bound to one action and lasts 2 minutes, so it can't be replayed for another action.
- **Not enough against:**
  - **Phishing on the phone.** A passkey can't be typed into a fake page; a password can.
  - **A keylogger on this computer.**
  - **Plain HTTP off this computer.** That case is refused anyway.
- **Neither method closes the honest limit in #3212.** A program running as the same OS user can rewrite the data folder, including any pinned passkey list or the password hash. That is DOR-3053's work, and it applies to both methods equally.

## Sizes and what gates what

| #   | PR                                                                                                                                                                                        | Size                      | Depends on                                 | Unblocks                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------ | --------------------------------------------------- |
| 1   | **Server:** statement + `requireStepUp` guard + password proof + domain-separation tests + Activity log + rate limit                                                                      | ~2 days                   | #3212 merged (reuses `checkOwnerPassword`) | DOR-3213, 3214, 3216 server sides; DOR-3271 Confirm |
| 2   | **Client:** "Confirm it's you…" sheet with the server-built reason line, password field, all states (cooldown, plain-HTTP, expired, cancelled), per designer spec v1.4                    | ~1.5 days                 | PR 1                                       | The Allow path, end to end                          |
| 3   | **Passkeys in the browser:** shared `verifyPasskeyAssertion` refactor, per-origin local key store, enrol + assert at `localhost` and the managed hostname, `127.0.0.1` → `localhost` link | ~2.5 days                 | PR 1, 2                                    | Touch ID / phone passkeys on the web                |
| 4   | **Desktop Touch ID:** `configureWebAuthn`, entitlement, account picker event, CI-signed proof                                                                                             | ~1 day + a CI signing run | PR 3; a signed CI build                    | Touch ID in the desktop app                         |

- **Critical path for the Allow path:** PR 1 → PR 2, about **3.5 to 4 days**, as 2 PRs (the ticket's original "about 2 PRs").
- **Passkeys everywhere:** add PR 3 and PR 4, about **3.5 more days**. All four PRs touch auth and open on `hold` for @security-auditor.
- PR 4 is the only one that needs a signed build. It is the one risk that is outside our hands.

## Prototype evidence

Throwaway files in `/tmp/dor3234-spike/` (removed after the spike):

- **The server:** a plain Node relying party on ports 47231 (http) and 47232 (https). It uses the repo's own `@simplewebauthn/server`, with the challenge bound to an action string.
- **The browsers:** Playwright Chromium (146) and WebKit, each with a fake CDP authenticator (`WebAuthn.addVirtualAuthenticator`, internal, UV on).
- **The desktop app:** Electron 41.10.7 with `--use-mock-keychain` and an in-memory session, plus the same fake authenticator through `webContents.debugger`.

| Case                                                                     | Result                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Chromium, `http://localhost`, RP `localhost`                             | register `verified: true`; sign-in `verified: true, uv: true`                                                 |
| Chromium, `localhost` asking RP `example.com`                            | `SecurityError: The relying party ID is not a registrable domain suffix of, nor equal to the current domain…` |
| Chromium, `http://127.0.0.1` and `http://[::1]` (RP = IP or `localhost`) | `SecurityError: This is an invalid domain.`                                                                   |
| Chromium, `https://abc.tunnel.test` (trusted test cert), RP = hostname   | register and sign-in verified                                                                                 |
| Same passkey, page moved to `https://xyz.tunnel.test`                    | RP `abc…`: `SecurityError`; RP `xyz…`: `NotAllowedError` (no passkey)                                         |
| WebKit, `http://localhost` and `http://127.0.0.1`                        | `isSecureContext: true`, API present                                                                          |
| Electron 41.10.7, no authenticator added                                 | `isUserVerifyingPlatformAuthenticatorAvailable() = false`                                                     |
| Electron 41.10.7, `http://localhost`, fake authenticator                 | register `verified: true`; sign-in `verified: true, uv: true`                                                 |
| Electron 41.10.7 `app.configureWebAuthn`                                 | `function` (present)                                                                                          |

Two caveats:

- **No real Touch ID or iCloud Keychain run.** The brief rules out real enrolment, so the measured results show the plumbing and the origin and RP rules, not the OS sheet itself. That part rests on the vendor sources above.
- **TLS errors weren't tested.** Headless Chromium allowed WebAuthn on a page with a TLS error when told to ignore it. Real Chrome's behavior on cert errors was not tested. The managed remote address has a valid certificate, so it doesn't matter here.
