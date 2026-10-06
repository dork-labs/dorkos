---
title: 'A secrets core for every account (human and agent)'
date: 2026-10-06
type: internal-architecture
status: active
tags: [secrets, vault, encryption, age, credentials, payments, vision-202610]
feature_slug: vision-202610
---

# A secrets core for every account (human and agent)

Checked 2026-10-06. Scratch research for the vision-202610 programme. Web research ran in three
parallel tracks: vault licences, crypto libraries and key hierarchies, and use-don't-read plus
payments. npm metadata was checked directly with `npm view` the same day. No secret value appears here.

**Status of claims.** Anything not confirmed from a primary source (a LICENSE file, vendor docs, a
spec, the npm registry) is marked **UNVERIFIED**.

---

## 0. The answer in one screen

- **Core format and library: age**, through **`age-encryption`** (typage, by Filippo Valsorda).
  It is BSD-3-Clause, pure TypeScript, and depends only on the `@noble/*` libraries. The server
  already depends on `@noble/curves`. age needs no server process and has native multi-recipient
  encryption, so "share with another account" and "move to another host" both mean the same
  thing: wrap one key for one more recipient. No new crypto gets written.
- **Not a vault server.** Every real vault server is a separate process: Infisical needs Postgres
  and Redis, OpenBao and Vaultwarden are separate binaries, and Bitwarden, Passbolt and Psono
  are client-server apps. Some have a blocking licence: Vault is BSL, Bitwarden's commercial
  modules forbid production use, and Vaultwarden, Passbolt and Padloc are AGPL. Bitwarden's
  client crypto is GPL-3.0, so it cannot go into MIT code. Tink's JS port is discontinued.
  `kdbxweb` is MIT but dormant (last npm publish 2022-06), and KDBX has one key per file, so
  sharing is impossible.
- **Key hierarchy (Bitwarden's shape, age's primitives):** host key → account key → vault key →
  items. The host key sits in the OS keystore. Each account (human or agent) has its own age
  identity, and each vault (a "collection") has its own age identity, wrapped to every member
  account.
- **Move to another instance:** the target sends its host recipient over the paired link. The
  source wraps the agent's account key to it and ships the vault ciphertext unchanged. Nothing is
  decrypted in transit, and the cloud never needs a passphrase.
- **Use, don't read:** the broker lives **outside the agent's Linux box**. API keys use
  placeholders swapped at the box's egress proxy, bound to a destination host. Logins are filled
  over CDP from the host side, bound to the site's origin, with TOTP codes computed host-side.
  Cards: an agent gets a scoped token or a single-purpose virtual card, never the person's real
  card.
- **The per-agent Linux box changes the old advice.** An earlier report worried about two
  things: a broker on the same uid as the agent, and asking users to trust a local CA. DorkOS
  builds the box image, so it can bake in trust for the CA. And the box's only route out can be
  the broker, so the boundary becomes a real one, not an honour system.

---

## 1. What exists in the repo today

| Piece                                                             | What it does                                                                                                                                                                                                | Gap against the new vision                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/core/credential-provider.ts` (ADR 0315) | A `CredentialProvider` port resolves `keychain:` / `env:` / `file:` references at the runtime env-injection seam. It never throws, has typed failures and never echoes a secret                             | **Install-level.** There is no idea of an account, an agent or a vault. `keychain:` is macOS only, through the `security` CLI. The resolved value is **injected into the agent's env**, which is the "Readable" mode                                                                                                                                     |
| `packages/shared/src/extension-secrets.ts` (ADR 0214)             | AES-256-GCM files under `{dorkHome}/extension-secrets/`, keyed by scrypt over a random `{dorkHome}/host.key` (mode 0600)                                                                                    | The ADR itself says it is not hardware-backed and that the host key sits next to the ciphertext. "No multi-machine sync" is listed as acceptable, which the new vision reverses                                                                                                                                                                          |
| `apps/server/src/services/browser/egress/broker/*`                | A private egress broker for the managed browser: per-run authority, grants, quotas, proxy credentials. Its README says it is **dormant**: "App startup does not mount it"                                   | It is the natural host for placeholder substitution and for credential fill. Today it carries only its own proxy-auth credential                                                                                                                                                                                                                         |
| Connectors (Composio and Nango, ADR `260804-021140` vocabulary)   | OAuth tokens held server-side by the provider. The agent gets an action, not a token                                                                                                                        | Keep as is. It is the right answer for OAuth services, and the vault should not duplicate it                                                                                                                                                                                                                                                             |
| `research/20260919_agent-secrets-and-vault.md`                    | Said **don't build a vault**. Build references (`op://`, `bws://`, `infisical://`, a reserved `cloud://`), a local egress proxy, delegated token minting and a three-type UI (Readable, Usable, Setup only) | The founder's constraints override the "don't build" half: free locally, 1Password can't be the default, every account needs its own vault. The other three recommendations still stand and are reused below. The reconciliation: **build a vault product on a vetted format, not custody crypto**, and keep external managers as first-class references |

---

## 2. Candidates compared (licence first)

### 2.1 Vault servers and products

| Candidate                            | Licence                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Separate process?                                                                                                                                             | Embeddable in Node?                                  | Verdict                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Infisical** (core)                 | MIT outside `ee/`. `ee/` is the proprietary Infisical Enterprise License, needing a paid key for production ([LICENSE](https://github.com/Infisical/infisical/blob/main/LICENSE), [ee/LICENSE.md](https://github.com/Infisical/infisical/blob/main/backend/src/ee/LICENSE.md))                                                                                                                                                                                                     | Yes: backend plus **Postgres plus Redis**, minimum 2 CPU / 4 GB ([self-host docs](https://infisical.com/docs/self-hosting/deployment-options/docker-compose)) | No. `@infisical/sdk` is an HTTP client (ISC per npm) | Too heavy for the local default. Support it as an `infisical://` reference                                                                                                                                                                                                                                                                                |
| **Infisical Agent Vault**            | MIT, with its own `ee/` carve-out ([repo](https://github.com/Infisical/agent-vault))                                                                                                                                                                                                                                                                                                                                                                                               | Yes, a standalone service. Its docs say to run it on a separate machine from the agent. SQLite by default                                                     | No. A TS SDK exists for orchestrators                | **Borrow the design** (placeholder substitution at egress). Don't embed it. It is still marked "API subject to change". Agent Proxy (hosted) went GA on 2026-07-30 on all tiers ([PRWeb](https://www.prweb.com/releases/infisical-launches-agent-proxy-so-teams-can-ship-ai-agents-without-handing-over-real-credentials-302838708.html))                 |
| **OpenBao**                          | **MPL-2.0**, Linux Foundation / OpenSSF ([repo](https://github.com/openbao/openbao)). v2.7.1 shipped 2026-10-01, a security patch ([releases](https://github.com/openbao/openbao/releases))                                                                                                                                                                                                                                                                                        | Yes, a Go server                                                                                                                                              | No                                                   | A sound licence and a strong engine (transit, per-namespace sealing in 2.6). It is a **candidate for the hosted or self-hosted server's key service** (KMS role), not for the laptop                                                                                                                                                                      |
| **HashiCorp Vault**                  | **BSL 1.1** since 1.15 (Aug 2023). The licensor is now IBM. The Additional Use Grant forbids offering it "on a hosted or embedded basis" to compete ([LICENSE](https://github.com/hashicorp/vault/blob/main/LICENSE))                                                                                                                                                                                                                                                              | Yes                                                                                                                                                           | No                                                   | **Excluded.** Bundling or hosting it for third parties plausibly trips the grant. Use OpenBao instead                                                                                                                                                                                                                                                     |
| **Vaultwarden**                      | **AGPL-3.0** ([LICENSE.txt](https://github.com/dani-garcia/vaultwarden/blob/main/LICENSE.txt))                                                                                                                                                                                                                                                                                                                                                                                     | Yes, a single Rust binary on SQLite                                                                                                                           | No                                                   | Excellent for people who want Bitwarden apps on their phone. **Flag AGPL:** fine as an optional, separately run component, not inside the MIT app                                                                                                                                                                                                         |
| **Bitwarden** server / clients / SDK | Server is AGPL-3.0 plus `LICENSE_BITWARDEN.txt` (commercial modules: internal non-production use only, "no competing product"). Clients are GPL-3.0. **`@bitwarden/sdk-internal` is GPL-3.0** (npm reports `GPL-3.0`; licensing PR [#10](https://github.com/bitwarden/sdk-internal/commit/db648d7ea85878e9cce03283694d01d878481f6b)). The old `bitwarden/sdk` became `sdk-secrets` under the proprietary "Bitwarden SDK License" (`@bitwarden/sdk-napi`: "SEE LICENSE IN LICENSE") | Yes                                                                                                                                                           | Only as GPL code                                     | **Excluded as a core** (copyleft or proprietary). **Copy the key-hierarchy design**, which is documented in the [whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/). Bitwarden Secrets Manager stays usable as a `bws://` reference. Whether `sdk-secrets` forbids non-Bitwarden servers is **UNVERIFIED** (the LICENSE fetch 404'd) |
| **Passbolt**                         | AGPL-3.0. CE and Pro share one codebase since 5.13 ([blog](https://www.passbolt.com/blog/passbolt-5-13-one-open-source-codebase-for-community-and-pro-editions))                                                                                                                                                                                                                                                                                                                   | Yes, PHP plus MySQL                                                                                                                                           | No                                                   | Excluded (AGPL, heavy, PGP-based)                                                                                                                                                                                                                                                                                                                         |
| **Psono**                            | **Apache-2.0**, server and client ([LICENSE.md](https://github.com/psono/psono-server/blob/master/LICENSE.md))                                                                                                                                                                                                                                                                                                                                                                     | Yes, server plus database                                                                                                                                     | No                                                   | The cleanest licence among the servers, but still a separate web app. Not a core                                                                                                                                                                                                                                                                          |
| **Padloc**                           | AGPL-3.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Yes                                                                                                                                                           | No                                                   | Excluded. Low activity, last commit seen 2025-03 (health **UNVERIFIED**)                                                                                                                                                                                                                                                                                  |
| **Proton Pass**                      | Clients GPL-3.0. **Server closed, no self-host** ([Proton](https://x.com/ProtonPrivacy/status/1674361805039190019))                                                                                                                                                                                                                                                                                                                                                                | n/a                                                                                                                                                           | No                                                   | Excluded                                                                                                                                                                                                                                                                                                                                                  |
| **Doppler**                          | CLI Apache-2.0 (lightly sourced). The service is **SaaS only**                                                                                                                                                                                                                                                                                                                                                                                                                     | Their cloud                                                                                                                                                   | No                                                   | Excluded as a default (not free locally, not OSS). Possibly a reference scheme                                                                                                                                                                                                                                                                            |
| **Teller**                           | Apache-2.0. Maintenance cadence **UNVERIFIED** (low)                                                                                                                                                                                                                                                                                                                                                                                                                               | No, it is a CLI                                                                                                                                               | No                                                   | A broker over other backends, not a vault. Ignore                                                                                                                                                                                                                                                                                                         |

### 2.2 Libraries and formats (the embeddable layer)

| Candidate                              | Licence (npm, checked 2026-10-06)                                                                                                                             | Health                                                                                                                         | Fit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`age-encryption`** (typage)          | **BSD-3-Clause**, v0.3.1, published 2026-08-28. Dependencies: `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum`, `@scure/base`        | Active, credible author (Go crypto maintainer). **No third-party audit found (UNVERIFIED / likely none). Pre-1.0**             | **Chosen.** age spec ([C2SP](https://github.com/C2SP/C2SP/blob/main/age.md)): a random file key is wrapped per recipient stanza (X25519, scrypt passphrase, plugin and newer hybrid post-quantum types), and the payload is ChaCha20-Poly1305. Multi-recipient is native, and adding a recipient re-wraps one 16-byte key. Runs in Node, the browser, Deno and Bun ([repo](https://github.com/FiloSottile/typage)). Interoperates with the Go `age` and Rust `rage` CLIs, so a user can decrypt their own export without DorkOS |
| `@noble/ciphers`, `/curves`, `/hashes` | MIT, v2.4.0 (2026-08)                                                                                                                                         | Actively maintained. The noble libraries have had public audits (not re-verified here)                                         | The underlying primitives. Already in the dependency tree via `@noble/curves` (`services/communities/buzz/buzz-identity.ts`)                                                                                                                                                                                                                                                                                                                                                                                                    |
| **`sodium-native`**                    | MIT, v5.1.0 (2026-05). libsodium itself is ISC, audited in 2017 by Matthew Green ([PIA](https://www.privateinternetaccess.com/blog/libsodium-audit-results/)) | Healthy (Holepunch)                                                                                                            | A good fallback primitive set (sealed boxes, secretstream). But it is a native addon with prebuilds, and it is not a format. You would design the envelope yourself, which is the thing we must not do                                                                                                                                                                                                                                                                                                                          |
| `libsodium-wrappers`                   | ISC, v0.8.4 (2026-04), WASM                                                                                                                                   | Healthy                                                                                                                        | Same as above, no native build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`kdbxweb`**                          | MIT, v2.1.1, **last npm publish 2022-06-19**                                                                                                                  | **Dormant.** It needs an external Argon2 for KDBX4 ([README](https://github.com/keeweb/kdbxweb))                               | **Import and export only.** KDBX has one composite key per file and no multi-recipient sharing. KeePassXC's KeeShare makes one database per pair ([discussion](https://github.com/keepassxreboot/keepassxc/discussions/12878)). A great escape hatch ("export this agent's vault to KeePassXC"), a poor core                                                                                                                                                                                                                    |
| KeePassXC                              | GPL ([LICENSE](https://github.com/keepassxreboot/keepassxc/blob/develop/LICENSE.GPL-3))                                                                       | Healthy                                                                                                                        | A desktop app. Interop target only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **SOPS**                               | MPL-2.0, CNCF, Go                                                                                                                                             | Healthy                                                                                                                        | Field-level encryption of config files over age or KMS. There is no Node implementation, so you shell out. Useful as a **pattern** for committing encrypted config. Not needed in core                                                                                                                                                                                                                                                                                                                                          |
| Google **Tink**                        | Apache-2.0                                                                                                                                                    | **JS/TS discontinued.** `tink-crypto` npm 0.1.1 dates from 2023 ([issue #689](https://github.com/tink-crypto/tink/issues/689)) | Excluded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **keytar**                             | MIT. The repo is **archived** (Atom, 2022-12)                                                                                                                 | Dead                                                                                                                           | Excluded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **`@napi-rs/keyring`**                 | MIT, v2.1.0 (2026-09)                                                                                                                                         | Healthy, wide prebuild matrix                                                                                                  | **Chosen** for the host key on macOS, Windows and Linux desktop. Caveat: on Linux with no Secret Service it **silently falls back to the kernel keyring, which does not survive a reboot** ([npm](https://www.npmjs.com/package/@napi-rs/keyring)). Detect that and refuse it                                                                                                                                                                                                                                                   |
| Electron `safeStorage`                 | (Electron)                                                                                                                                                    | n/a                                                                                                                            | An alternative for the desktop app. On Linux with no secret store it falls back to **`basic_text`, a hardcoded key**. Detect it with `getSelectedStorageBackend()` ([docs](https://www.electronjs.org/docs/latest/api/safe-storage))                                                                                                                                                                                                                                                                                            |
| `systemd-creds`                        | (systemd)                                                                                                                                                     | n/a                                                                                                                            | **Headless Linux host key.** AES-256-GCM keyed by TPM2 and/or `/var/lib/systemd/credential.secret`, bound to the machine ([systemd.io](https://systemd.io/CREDENTIALS/))                                                                                                                                                                                                                                                                                                                                                        |
| `otpauth`                              | MIT, v9.5.2 (2026-09)                                                                                                                                         | Healthy                                                                                                                        | Computes TOTP host-side from an `otpauth://` URI (the KeePassXC/KeeWeb convention for the `otp` field)                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 2.3 Why age over the alternatives, in one paragraph

The requirements are no new crypto, no server, free, MIT-compatible, multi-recipient, portable
across hosts, and something a user can open without DorkOS. Only age satisfies all seven at
once. libsodium is audited and stronger on pedigree, but it is a toolkit. Using it means
designing an envelope, a recipient format and a rotation scheme, which is exactly the "write our
own crypto" the founder ruled out. KDBX is a real format with real tools, but it is single-key.
The honest cost of age is that **typage is pre-1.0 and, as far as found, unaudited**. Two
mitigations: pin it, and keep the format standard so the Go and Rust reference implementations
can cross-check DorkOS's output in CI. Budget for a paid audit before GA (see risks).

---

## 3. Key hierarchy (Bitwarden's shape, age primitives)

Reference: Bitwarden. A master key is derived from the password (PBKDF2 or Argon2id), stretched
by HKDF, and wraps a random user symmetric key. Each user has an RSA key pair. An organisation
key is random and wrapped to each member's public key. Collections sit within an org. Emergency
access and admin account recovery wrap keys to another member. Trusted devices hold a device key
([whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/),
[trusted devices](https://bitwarden.com/help/about-trusted-devices/)). 1Password adds a
128-bit Secret Key next to the password (2SKD), so a server breach alone can't be brute-forced
([whitepaper](https://1passwordstatic.com/files/security/1password-white-paper.pdf)).

DorkOS mapping. Every "key" below is an age X25519 identity, or a hybrid post-quantum identity
if typage's hybrid recipient is adopted (spec support confirmed; exact typage API **UNVERIFIED**):

```
Host key (one per DorkOS instance)
  stored: OS keystore via @napi-rs/keyring (macOS Keychain, Windows Credential Manager/DPAPI,
          Linux Secret Service) | systemd-creds/TPM2 on headless Linux | cloud: per-tenant key in a
          KMS/OpenBao transit engine (private repo decides) | file 0600 = "degraded", shown in UI
  │ wraps
  ▼
Account key (one per principal, human OR agent, identical shape)
  wrapped to: each host where the account is active
            + humans: a passphrase (age scrypt) and/or passkey PRF, so a human can unlock on a new device
            + recovery: a printed recovery code (age scrypt, separate wrapped copy)
            + escrow (optional, per-account policy): the account key of a named recovery holder
              (an agent's sponsor, an admin; Bitwarden "account recovery" analogue)
  │ wraps
  ▼
Vault key (one per vault = a Bitwarden-style collection)
  wrapped to: every member account's public recipient
  │ encrypts
  ▼
Items (login + TOTP seed, API key, recovery codes, card/token, note), each its own age blob
```

Notes:

- **Every account starts with a personal vault.** Shared vaults are how a human gives an agent a
  credential, or how two agents share one. Membership carries a **permission** (Use, Read, Manage)
  that the broker enforces. The cryptography can't enforce "Use only": a Use-only member has to
  be a member whose wrapped key is held **by the broker on the member's behalf**, never handed to
  the agent's box. This is the important twist on Bitwarden. For agents, **the account key is
  never inside the agent's box**. It lives with the DorkOS server that runs the broker.
- **Human/agent symmetry** (the founder's direction: accounts are nearly identical). The only
  difference is the unlock factor. Humans have a passphrase or passkey. Agents have only host
  wraps plus escrow. An agent can be a vault manager and add a human. Nothing in the format
  privileges humans.
- **Item metadata.** Origin, type and name must be readable by the broker to do origin-matched
  fill. Keep them inside the ciphertext, and keep an index in SQLite encrypted under the vault
  key. Never store plaintext names, so a stolen `~/.dork` reveals nothing about _which_ sites.
- **Storage.** Item blobs live in SQLite (the `@dorkos/db` stack), or as files under
  `{dorkHome}/vaults/<vaultId>/` (simplest to sync and move). Recommend files plus a derived SQLite
  index, matching ADR-0043's "file is truth, SQLite is cache". **Decision open.**
- **Migration.** `host.key` (ADR 0214) and the `file:` scheme become the first consumers. The
  extension secret store and runtime credentials move into a "system" vault owned by the instance
  account. The `CredentialProvider` port gains a `vault:<vaultId>/<itemId>/<field>` scheme.
  `keychain:` / `env:` stay as escape hatches, and `op://` / `bws://` / `infisical://` are added as
  external references (from the 2026-09-19 report).

---

## 4. Sharing model

**Bitwarden's organisations and collections, flattened onto DorkOS spaces:**

| DorkOS concept             | Bitwarden analogue                                         | Key                                                                                   |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A person or agent account  | user                                                       | account key                                                                           |
| A space (community, team)  | organisation                                               | none of its own. A space is a membership list. Vaults belong to it                    |
| Vault                      | collection                                                 | vault key, wrapped per member                                                         |
| Grant: Use / Read / Manage | collection permission (can view / hide passwords / manage) | Use is broker-enforced, Read gives the member a wrap, Manage can add and remove wraps |

- **Add member:** a manager unwraps the vault key and wraps it to the new member's recipient. It
  is O(1) and items are untouched.
- **Remove member:** rotate the vault key, re-encrypt the items (they are small), drop the old
  wraps. **Revocation can't unsee:** anything a Read member already saw must be rotated at the
  issuer. The UI says so, and offers a "rotate these 4 passwords" checklist. Use-only members never
  saw a value, so removing them is clean. This is a strong argument for Use as the default for
  agents.
- **Why not MLS (RFC 9420):** it is built for fast-churning chat groups with forward secrecy.
  Vault groups are small and stable, so age wraps are enough
  ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)).

---

## 5. Moving an agent to another instance (cloud or self-hosted)

Prior art: Claude Code cloud sessions keep GitHub and API credentials server-side behind a proxy,
"never enter a session's VM", and `--teleport` moves the transcript and branch, not credentials
([docs](https://code.claude.com/docs/en/claude-code-on-the-web)). Devin's snapshots deliberately
exclude credentials (secondary, **UNVERIFIED**). Fly secrets are app-scoped and injected at boot
([docs](https://fly.io/docs/reference/secrets/)). DorkOS's version can be stronger because the
vault itself is portable ciphertext:

1. **Pair.** The target instance is already linked to the user (the same link the publish flow
   uses). It presents its **host recipient**, signed by its instance identity. The source shows
   the user a short fingerprint or the target's name to confirm.
2. **Wrap.** The source unwraps the agent's account key with its own host key and wraps it to the
   target host recipient. It does the same for any shared vault the agent is a member of, if the
   user ticks "take shared vaults too". Otherwise the agent arrives with only its personal vault.
3. **Ship.** The vault directories go over unchanged (already ciphertext), plus the new wraps.
   Nothing is decrypted in transit, and the transport does not need to be trusted for
   confidentiality (only integrity, which age's header MAC provides).
4. **Lease.** This rides the runner-lease handoff from the "one server" research note: pause the
   turn, move, resume. On **move** the source deletes its host wrap. On **copy** both keep wraps,
   and the vault shows two hosts.
5. **Re-establish host-bound state.** Cookies and sessions, device-bound OAuth refresh tokens and
   IP-pinned API keys may not work from the new host. The broker reports these per item instead
   of failing mid-task. Optional: "rotate high-value secrets after moving".
6. **Offline / air-gapped self-host:** export a `.dorkvault` bundle (age-encrypted, recipient =
   the target host key, or a passphrase). Import it on the other side. The same bundle works
   with `age -d` for the user's own escape hatch, and a KDBX export via `kdbxweb` serves KeePassXC
   users.

**The honest sentence for the cloud:** when an agent _runs_ on DorkOS Cloud, the cloud host can
decrypt that agent's vault while it runs. That is inherent to running there, the same as
Claude Code's cloud. Zero-knowledge holds only for vaults _stored_ in the cloud as sync or backup
for agents that run elsewhere. That cloud can't open those. Say it in the product, not in a
whitepaper.

---

## 6. "Use, don't read"

The three secret types carry over from the 2026-09-19 report: **Readable** (injected), **Usable**
(brokered), **Setup only** (Codex-style phase separation). Default every agent-held item to
**Usable**. A Usable item must never silently downgrade to Readable.

### 6.1 Where the broker lives

On the **host DorkOS server, outside the agent's Linux box.** The box's network goes only through
the DorkOS egress broker (the dormant `services/browser/egress/broker` is the seed). This moves
the boundary from "same uid, policy" (the earlier worry, and Infisical's "a single kernel
exploit voids the entire threat model",
[Infisical](https://infisical.com/blog/credential-brokering-for-ai-agents)) to "a container or VM
boundary". It is still not physics, but it is a real kernel or hypervisor boundary. **Host-shell
mode (no box) is a named degraded mode** in the UI.

### 6.2 API keys: placeholder at egress

- The box's env holds `DORKOS_SECRET_<name>`-style placeholders (Infisical Agent Vault's
  mechanism, MIT, [repo](https://github.com/Infisical/agent-vault)). OneCLI does the same with
  `FAKE_KEY` swaps ([YC](https://www.ycombinator.com/launches/RoJ-onecli-your-ai-agents-shouldn-t-be-holding-raw-secrets);
  its licence and TLS mechanism are **UNVERIFIED**). agentgateway (Apache-2.0, Linux Foundation) does
  it at the MCP/HTTP gateway with RFC 8693 token exchange
  ([blog](https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/)).
  Cloudflare's sandbox outbound workers inject outside the sandbox
  ([blog](https://blog.cloudflare.com/claude-managed-agents/)).
- **The local CA problem disappears for boxes.** DorkOS builds the box image, so it installs the
  broker's CA into the box trust store. The CA private key stays on the host and is never in the
  box. The user is not asked to trust anything on their own machine.
- **Every placeholder is bound to destination hosts** (`api.openai.com` only). Substitution is
  confidentiality, not authorisation: an injected agent can still _use_ the key against its real
  host. Per-destination binding, rate limits and the approval tiers that already exist are the
  authorisation half.
- Never log request bodies, and redact the substituted value from any response that echoes it.

### 6.3 Website logins and TOTP: fill from outside

Prior art:

- **1Password Agentic Autofill.** An E2E channel to a headless extension in Browserbase, with
  per-fill human approval. The agent never sees the value
  ([1Password](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents)).
  Its TOTP and origin-binding details are secondary-sourced (**UNVERIFIED**).
- **Browser Use `sensitive_data`.** The LLM sees placeholder names, values are substituted after
  the action is generated, `allowed_domains` is mandatory, and `use_vision=False` is advised
  ([docs](https://docs.browser-use.com/open-source/examples/templates/sensitive-data)). There is a
  known bug where placeholder name collisions across domains leak
  ([#5592](https://github.com/browser-use/browser-use/issues/5592)).
- **Stagehand `%variable%` substitution** ([docs](https://docs.stagehand.dev/v3/basics/agent)).
- **Bitwarden MCP server** (2025-07). It appears to let the calling agent _fetch_ values, which
  is a weaker boundary (**UNVERIFIED**) ([blog](https://bitwarden.com/blog/bitwarden-mcp-server/)).

DorkOS mechanism:

1. The agent asks a tool `vault_fill({ item: "github-login", step: "password" })`. It names the
   item, never sees the value.
2. The host-side broker holds the CDP connection to the box's browser. It checks the **top-level
   origin exactly matches** the item's saved origin, using the registrable domain, never a
   substring. It then fills with `Input.insertText` / `DOM.setAttributeValue` from outside the box.
3. TOTP: the broker computes the code from the seed with `otpauth` (MIT) and fills it. The seed
   never leaves the vault.
4. Every fill writes an Activity line ("agent X used GitHub login on github.com"). The first use
   per item, or every use for a high-value item, can require approval through the existing tier
   gate.

**Residual risks, stated plainly:**

- **DOM read-back.** Once filled, page JS can read `input.value`. An agent that controls its own
  box can attach its own CDP, so it can read a filled field. Mitigations: fill as late as possible
  and submit in the same broker action; block DorkOS's own `eval`-style browser tools on pages
  holding a filled credential; prefer hand-off of the **post-login session** over refilling.
  Honest copy: "Your agent can sign in with this. It is kept out of the conversation." Do not
  write "your agent can never get it". The stronger variant is to log in through a **broker-owned
  browser profile outside the box** and move only the session cookies in. That keeps the password
  and seed out, though cookies are then readable. **Design open.**
- **Screenshots.** Password fields are masked, TOTP and API-key fields often are not, and React
  mirrors values into attributes ([quilr.ai](https://quilr.ai/resources/browser-agents-are-reading-your-passwords),
  secondary). Suppress or redact screenshots between fill and submit.
- **`isTrusted`.** Some sites reject CDP-synthesised events (secondary). Fall back to OS-level
  input inside the box's desktop (xdotool or similar) driven by the broker.

### 6.4 Recovery codes, card details and notes

These are Readable by humans and never by agents by default. An agent that needs a recovery code
asks through an approval card. The human approves, and the broker fills it once.

---

## 7. Payment cards

- **PCI DSS scope.** Storing full PANs as a business puts that business in scope: Requirement 3
  (render the PAN unreadable), 3.5 and 3.6 (key management, custodians, rotation)
  ([guide](https://pcidssguide.com/pci-dss-requirement-3/),
  [RSI](https://blog.rsisecurity.com/pci-compliance-key-management-requirements/)). "SAQ D" as the
  tier is an inference (**UNVERIFIED**). A person storing **their own** card in their **own**
  local vault is outside PCI, which governs merchants and service providers (**UNVERIFIED**, no
  PCI SSC statement found). The question that matters for DorkOS Cloud: does syncing
  zero-knowledge ciphertext of users' cards make DorkOS a service provider in scope? PCI SSC has
  FAQ guidance that encrypted cardholder data can be out of scope for an entity with no access to
  the keys (from memory, **UNVERIFIED**, check before launch). Cloud-_run_ agents break that
  condition, because the cloud host holds the keys while running.
- **Recommendation: agents never hold a real card.** Give agents:
  - **Stripe Issuing virtual cards**: per-agent, with per-transaction and monthly limits, MCC
    allow and block lists, single-use, and real-time authorisation webhooks
    ([docs](https://docs.stripe.com/issuing/agents)). Caveat: a virtual card is still a PAN, so
    it is stored as a Usable item, filled only on the checkout origin, and the limits are the real
    control.
  - **Shared Payment Tokens via ACP**: scoped to one merchant, one amount and one expiry, carrying
    brand and last 4 only, never the PAN. The spec is Apache-2.0
    ([repo](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)).
  - Watch: Visa Trusted Agent Protocol (restrictive spec licence,
    [terms](https://developer.visa.com/capabilities/trusted-agent-protocol/product-terms)),
    Mastercard Agent Pay (proprietary, MDES), Google AP2 mandates (Apache-2.0,
    [ap2-protocol.org](https://ap2-protocol.org/)), and x402 (licence **UNVERIFIED**).
- A human's own card can live in their personal vault for their own autofill. It is **never
  shareable to an agent vault.** Enforce that by item type, and make the UI offer "create a
  virtual card for this agent" instead.
- Card issuing is a money path. It needs the same "own decision beside its own key" treatment as
  the other spend paths that already exist in this codebase. Pricing and plan details for any
  hosted card feature belong in the private repo.

---

## 8. Recommendation

| Question                                       | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Core library / format**                      | **age**, through `age-encryption` (typage, BSD-3-Clause) on `@noble/*` (MIT). Items are individual age blobs, encrypted to a per-vault recipient. TOTP in the `otpauth://` URI convention, generated with `otpauth` (MIT). Import and export in KDBX via `kdbxweb` (MIT), and Bitwarden/1Password CSV/JSON import. **No vault server in the local app.**                                                                                                                                                                                                                                                                                                     |
| **Where keys live locally**                    | The host key goes in the OS keystore through `@napi-rs/keyring` (or Electron `safeStorage` in the desktop app), with **explicit detection and refusal** of Linux's non-persistent keyring and the `basic_text` fallback. On headless Linux, `systemd-creds` (TPM2 when present). The last resort is a 0600 file, labelled degraded in the UI. Account and vault keys exist only as age wraps on disk. Agent account keys are unwrapped only in the host server process, never in a box                                                                                                                                                                       |
| **Where keys live in the cloud / self-hosted** | Same format, same files. The host key of a cloud or self-hosted instance sits in a KMS. OpenBao (MPL-2.0) transit is the open option for self-hosters. Vaults that only _sync_ to the cloud carry no cloud wrap, so they are zero-knowledge. Vaults of agents that _run_ there carry the cloud host's wrap, and the product says so. The cloud-specific choices belong in the private repo. The wire contract (the vault bundle format, the host-recipient exchange) goes in `packages/cloud-api`                                                                                                                                                            |
| **Sharing model**                              | Bitwarden-style. Spaces own vaults (collections). Membership is a wrap plus a grant of **Use / Read / Manage**. Use is the default for agents and is broker-enforced. Removal rotates the vault key and offers an issuer-rotation checklist. Humans and agents have the same shape. Optional escrow to a sponsor or admin is the recovery route for agents                                                                                                                                                                                                                                                                                                   |
| **Move flow**                                  | Pair, then the target presents a signed host recipient, then the account key (and chosen shared vaults) are re-wrapped to it, then the ciphertext ships unchanged, then the runner lease moves (on a move the source wrap is deleted), then host-bound items are reported. The offline path is a `.dorkvault` age bundle                                                                                                                                                                                                                                                                                                                                     |
| **Use, don't read**                            | The broker runs on the host, outside the agent's box, and the box's only egress is the broker. API keys are **placeholders substituted at egress**, bound to destination hosts (the CA is baked into the box image, its key stays on the host). Logins are filled over CDP from the host with **exact origin binding**, TOTP is computed host-side, and every use is logged with optional per-use approval. Cards are Stripe Issuing virtual cards or SPTs, never a person's real card. OAuth services stay on the connector providers. External managers (`op://`, `bws://`, `infisical://`) stay first-class references for people who already pay for one |

### Top risks

1. **typage is pre-1.0 and has no audit found (UNVERIFIED).** Pin it, cross-check against Go
   `age` and `rage` in CI with test vectors, and fund an external review of typage plus DorkOS's
   key-wrap layer before GA. If that can't happen, fall back to the Go `age` binary as a sidecar
   for the paranoid profile.
2. **A filled credential is readable by an agent that controls its own box.** Origin binding,
   late fill, blocking eval and session hand-off reduce it but don't remove it. The copy must not
   over-claim (the demo-claim gate applies).
3. **Agent account-key recovery.** An agent has no passphrase. If the only host is lost and there
   is no escrow, the vault is gone. Make escrow to the sponsor (or a printed recovery code) part
   of agent creation, and decide whether it can be declined.
4. **Linux key storage.** Silent fallbacks (kernel keyring, `basic_text`) look like they work and
   lose or expose keys. Detect them, refuse them, and show it.
5. **Cloud-run means cloud-readable.** Say it, and keep the zero-knowledge claim to sync and
   backup only.
6. **PCI.** Keep real PANs out of agent vaults and out of any cloud-run context. Get a qualified
   opinion before the cloud syncs card items. The encrypted-data-out-of-scope reading is
   **UNVERIFIED**.
7. **Revocation can't unsee.** Read grants to agents should be rare and loud. Use is the default.
8. **Host-shell mode** (no box) collapses the broker boundary to the same uid. Label it degraded.
   Don't hide it.
9. **Scope creep into a password-manager product.** Browser extensions, mobile apps and a
   Bitwarden-compatible API are each a product. Vaultwarden (AGPL, separate process) as an
   _optional_ companion for "use my agent's vault from my phone" is cheaper than building one,
   and its licence is fine as long as it isn't linked into the MIT app.

### What this supersedes or amends (for the ADR pass)

- ADR **0214**: the host key moves from a plain 0600 file plus scrypt to the OS keystore. Extension
  secrets become a system vault.
- ADR **0315**: `CredentialProvider` gains `vault:` and external-manager schemes, plus a
  **Usable** resolution path that returns a placeholder instead of a value.
- `research/20260919_agent-secrets-and-vault.md` §4.6 ("not a DorkOS password vault"): amended. It
  becomes a vault built on a standard format and library, with references to external managers
  kept.

---

## Gaps and unverified items

- `age-encryption` audit status (none found) and its exact hybrid post-quantum recipient API.
- `bitwarden/sdk-secrets` licence text (the fetch 404'd). Whether it forbids non-Bitwarden servers.
- 1Password Agentic Autofill TOTP and origin-binding specifics (secondary sources only).
- Whether the Bitwarden MCP server returns raw values to the agent.
- OneCLI licence and whether it does full TLS interception. x402 licence.
- PCI applicability to personal vaults, and to zero-knowledge ciphertext held by a service.
- Whether DorkOS's managed browser (`packages/browser`) is the browser _inside_ each agent's Linux
  box or a host-side browser. This decides whether CDP fill happens across the box boundary.
  Not traced in this pass.
- The noble libraries' audit history was not re-verified here.

## Sources

- Infisical: [LICENSE](https://github.com/Infisical/infisical/blob/main/LICENSE), [ee/LICENSE.md](https://github.com/Infisical/infisical/blob/main/backend/src/ee/LICENSE.md), [self-hosting](https://infisical.com/docs/self-hosting/deployment-options/docker-compose), [Agent Vault](https://github.com/Infisical/agent-vault), [Agent Vault blog](https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents), [Agent Proxy GA](https://www.prweb.com/releases/infisical-launches-agent-proxy-so-teams-can-ship-ai-agents-without-handing-over-real-credentials-302838708.html), [credential brokering](https://infisical.com/blog/credential-brokering-for-ai-agents)
- OpenBao: [repo](https://github.com/openbao/openbao), [releases](https://github.com/openbao/openbao/releases), [v2.6](https://openbao.org/blog/release-v2-6-0/), [v2.7](https://openbao.org/blog/release-v2-7-0/)
- HashiCorp Vault: [LICENSE (BUSL 1.1)](https://github.com/hashicorp/vault/blob/main/LICENSE), [BSL announcement](https://www.hashicorp.com/en/blog/hashicorp-adopts-business-source-license)
- Vaultwarden: [LICENSE.txt](https://github.com/dani-garcia/vaultwarden/blob/main/LICENSE.txt), [repo](https://github.com/dani-garcia/vaultwarden)
- Bitwarden: [server](https://github.com/bitwarden/server), [LICENSE_BITWARDEN.txt](https://github.com/bitwarden/server/blob/main/LICENSE_BITWARDEN.txt), [clients](https://github.com/bitwarden/clients), [sdk-internal licensing PR](https://github.com/bitwarden/sdk-internal/commit/db648d7ea85878e9cce03283694d01d878481f6b), [The Register](https://www.theregister.com/2024/11/04/bitwarden_gpls_password_manager/), [security whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/), [trusted devices](https://bitwarden.com/help/about-trusted-devices/), [PRF / passkey unlock](https://bitwarden.com/blog/prf-webauthn-and-its-role-in-passkeys/), [MCP server](https://bitwarden.com/blog/bitwarden-mcp-server/)
- Passbolt: [5.13 blog](https://www.passbolt.com/blog/passbolt-5-13-one-open-source-codebase-for-community-and-pro-editions). Psono: [LICENSE.md](https://github.com/psono/psono-server/blob/master/LICENSE.md). Padloc: [repo](https://github.com/padloc/padloc). Proton: [no self-host](https://x.com/ProtonPrivacy/status/1674361805039190019). Doppler: [cli](https://github.com/DopplerHQ/cli). Teller: [repo](https://github.com/tellerops/teller)
- age: [C2SP spec](https://github.com/C2SP/C2SP/blob/main/age.md), [typage](https://github.com/FiloSottile/typage), [rage](https://github.com/str4d/rage), [plugins](https://words.filippo.io/age-plugins/). SOPS: [CNCF](https://www.cncf.io/projects/sops/)
- KDBX: [KDBX 4](https://keepass.info/help/kb/kdbx_4.html), [kdbxweb](https://github.com/keeweb/kdbxweb), [KeeShare](https://github.com/keepassxreboot/keepassxc/discussions/12878), [otp field](https://github.com/keepassxreboot/keepassxc/issues/9847)
- libsodium: [sodium-native](https://github.com/holepunchto/sodium-native), [audit](https://www.privateinternetaccess.com/blog/libsodium-audit-results/). Tink: [JS discontinued](https://github.com/tink-crypto/tink/issues/689)
- Keystores: [node-keytar (archived)](https://github.com/atom/node-keytar), [@napi-rs/keyring](https://www.npmjs.com/package/@napi-rs/keyring), [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [systemd credentials](https://systemd.io/CREDENTIALS/)
- 1Password: [whitepaper](https://1passwordstatic.com/files/security/1password-white-paper.pdf), [Agentic Autofill blog](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents), [Agentic Autofill dev](https://www.1password.dev/agentic-autofill)
- Gateways: [agentgateway](https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/), [OneCLI](https://www.ycombinator.com/launches/RoJ-onecli-your-ai-agents-shouldn-t-be-holding-raw-secrets), [Docker MCP Gateway](https://github.com/docker/mcp-gateway), [Cloudflare](https://blog.cloudflare.com/claude-managed-agents/), [Aembit](https://securityboulevard.com/2026/04/aembit-iam-for-agentic-ai-is-now-generally-available/)
- Browser fill: [Browser Use sensitive data](https://docs.browser-use.com/open-source/examples/templates/sensitive-data), [#5592](https://github.com/browser-use/browser-use/issues/5592), [Stagehand](https://docs.stagehand.dev/v3/basics/agent), [Browserbase forms](https://docs.browserbase.com/use-cases/automating-form-submissions), [Browserbase TOTP](https://www.browserbase.com/templates/mfa-handling), [screenshot leakage (secondary)](https://quilr.ai/resources/browser-agents-are-reading-your-passwords), [DOM clickjacking](https://marektoth.com/blog/dom-based-extension-clickjacking/)
- Portability: [Claude Code cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [Devin secrets](https://docs.devin.ai/product-guides/secrets), [Fly secrets](https://fly.io/docs/reference/secrets/)
- Payments: [PCI Req. 3](https://pcidssguide.com/pci-dss-requirement-3/), [key management](https://blog.rsisecurity.com/pci-compliance-key-management-requirements/), [ACP spec](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol), [Stripe Issuing for agents](https://docs.stripe.com/issuing/agents), [Visa TAP terms](https://developer.visa.com/capabilities/trusted-agent-protocol/product-terms), [AP2](https://ap2-protocol.org/), [Mastercard Agent Pay (secondary)](https://genfinity.io/2026/06/10/mastercard-agent-pay-for-machines-launch/), [x402](https://www.coinbase.com/developer-platform/discover/launches/x402)
- Repo: `apps/server/src/services/core/credential-provider.ts`, `packages/shared/src/extension-secrets.ts`, `apps/server/src/services/browser/egress/broker/README.md`, `decisions/0214-*`, `decisions/0315-*`, `research/20260919_agent-secrets-and-vault.md`
