---
title: 'Agent secrets and a vault for DorkOS — the landscape, four design options, and the shape to build'
date: 2026-09-19
type: strategic
status: active
tags: [secrets, credentials, agents, 1password, infisical, composio, vault, security, competitors]
searches_performed: 16
sources_count: 34
---

# Agent secrets and a vault for DorkOS

**Checked 2026-09-19.** No secret value appears in this file, and none should be
added to it.

**The question.** DorkOS runs other people's agents against other people's
services. Every one of those agents eventually needs a credential — an API key, a
database URL, an OAuth token — and today the honest answer is "put it in a `.env`
and hope". Should DorkOS build a vault?

**The short answer.** No. Build the layer _above_ a vault and the layer _below_
it, and let somebody else hold the values. Between March and September 2026 the
credential-for-agents category converged on one architecture: **the agent holds a
reference or a placeholder, never a value, and something outside the agent's blast
radius performs the substitution.** The company with the most to gain from owning
custody built a vault, reached a $2.5B valuation, and then announced it was
brokering through a password manager instead. That is the strongest available
signal about which end of the problem is worth building.

**What DorkOS should build**, in order: a **reference layer** (`op://`, `env://`,
`bws://`, `infisical://`, with `cloud://` reserved for the hosted side), a **local
egress proxy** forked from an MIT placeholder-substitution design, **delegated
token minting** through the connector-provider seam that already exists, and a
**three-type secret UI** copied from Cursor. Sections 4.1 through 4.4.

---

## 1. The landscape

### 1.1 Where the boundary actually sits

Everything in this section is one of two things: a tool that **injects a value
into a process**, or a tool that **keeps the value out of the process and makes
the call for you**. The distinction is the whole subject.

Once a value is in the agent's process environment, `printenv` retrieves it. It
does not matter how the value got there, how well it was encrypted at rest, or
what the marketing page says about zero trust. The agent owns that process. So:

> **For a process the agent controls, every secrets manager on the market is
> policy, not physics.** Only moving the call itself out of the agent's process —
> a broker, an egress proxy, a server-side tool executor — changes the answer.

Infisical is the only vendor in the field that says this out loud: co-locating the
broker and the agent on one host means "a single kernel exploit voids the entire
threat model"
([Infisical](https://infisical.com/blog/credential-brokering-for-ai-agents)).

### 1.2 1Password's agent tooling

The most complete developer story in the field, and the one whose shape DorkOS
should assume its users already have.

| Surface                           | What it does                                                                                              | Where the boundary is                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `op read "op://vault/item/field"` | Resolves one reference to stdout                                                                          | **None** once resolved — the value is now in the caller's hands               |
| `op run --env-file=.env -- cmd`   | Resolves `op://` references in a `.env` and injects them into the child process only                      | Value never touches disk; still fully readable inside `cmd`                   |
| `op inject -i tpl -o out`         | Template substitution into a file                                                                         | **Writes plaintext to disk.** Avoid                                           |
| **1Password Environments**        | Named, shareable environment-variable sets per project and stage, with `.env` import                      | Same as `op run`                                                              |
| **Environments MCP server**       | Lets an agent list, create and rename Environments and append variables, and list variable **names** only | **"does not read or return secret values to the agent"**; per-action approval |
| **The Claude Code plugin**        | Bundles that MCP server, a skill, and a pre-Bash validation hook                                          | The agent "never receives secret values"                                      |
| **`1Password/agent-hooks`**       | MIT repo. Currently **one** hook: validation of mounted `.env` files                                      | Validation, not prevention                                                    |
| **Service accounts**              | Headless token, scoped per vault (`read_items`, `write_items`, `share_items`)                             | The token is a bearer credential — whoever holds it has the vault             |
| **Agentic Autofill**              | Hands a browser agent a signed-in session rather than the password                                        | The agent gets a session, not the secret                                      |
| **Unified Access**                | Governance platform: Discover and Secure shipped; Audit and runtime credential issuance "later in 2026"   | A governance layer, not a runtime one                                         |

Sources: the "variable names only" claim is stated in both the Cursor Marketplace
announcement
([1Password](https://1password.com/blog/the-1password-environments-mcp-server-is-now-on-cursor-marketplace))
and the Claude Code plugin docs
([1Password](https://www.1password.dev/environments/claude-plugin)); `.env` files
holding references rather than values is the documented `op run` pattern
([1Password Developer](https://developer.1password.com/docs/cli/secrets-environment-variables));
Unified Access GA on 2026-03-17 with Audit and runtime issuance still forthcoming
is from the press release
([1Password](https://1password.com/press/2026/mar/1password-unified-access)); the
single-hook state of the MIT hooks repo is from the repo itself
([GitHub](https://github.com/1Password/agent-hooks)).

**UNVERIFIED:** secondary sources claim those agent hooks _block_ `printenv` and
`op read`. The repo documents one hook, and it validates mounted `.env` files. Any
product that wants blocking behaviour writes that hook itself.

**UNVERIFIED:** "1Password Unlock" does not appear to exist as a named product.
Nothing retrievable names it. Treat it as a conflation with Unified Access or with
the desktop unlock flow.

### 1.3 Infisical Agent Proxy — the cheapest correct boundary

Infisical shipped **Agent Vault** in April 2026 under the MIT licence and then
**Agent Proxy** to general availability on 2026-07-30, on every tier including
free. The mechanism in both is the same and it is the single most copyable idea in
this report:

> The agent is configured with a **placeholder** — a literal string like
> `__openrouter_api_key__` — and a proxy substitutes the real credential **at the
> network boundary**, on the way out.

A prompt injection that exfiltrates the agent's whole environment exfiltrates
placeholders. The agent can _use_ the credential and can never _read_ it. The
predecessor is MIT-licensed and runs as a local MITM proxy, and its own
documentation says to deploy it on a separate machine
([GitHub](https://github.com/Infisical/agent-vault)); the GA announcement covers
Agent Proxy's tiering
([PRWeb](https://www.prweb.com/releases/infisical-launches-agent-proxy-so-teams-can-ship-ai-agents-without-handing-over-real-credentials-302838708.html)).

The honesty is the important part. Infisical states plainly that if the proxy and
the agent share a host and a uid, a kernel exploit voids the model
([Infisical](https://infisical.com/blog/credential-brokering-for-ai-agents)).
Anyone shipping this pattern owes their users the same sentence.

### 1.4 Cursor's three secret types — the only legible UI in the field

Cursor's cloud agents classify every secret into one of three kinds, and the
classification is the trust boundary said in words a non-developer can act on
([Cursor docs](https://cursor.com/docs/cloud-agent/security-network)):

| Type                     | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| **Environment Variable** | the agent may read this                                      |
| **Runtime Secret**       | not shown to the agent, though visible in a terminal session |
| **Build Secret**         | available during the image build only                        |

This maps one-to-one onto the design options in section 3: Environment Variable is
option (c), Runtime Secret is option (a), Build Secret is phase separation. It is
the piece of prior art most worth copying outright, because the hard part of this
whole problem is not cryptography — it is telling somebody who does not code which
of their keys the agent can see.

### 1.5 What the other coding agents do

| Product                         | Injection                                        | Isolation                                                                                                                                          |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI Codex cloud**          | encrypted secrets decrypted per task             | **available only to setup scripts and removed before the agent phase starts**; the agent phase has no internet by default, with a domain allowlist |
| **Cursor cloud agents**         | encrypted environment variables at runtime       | the three types above                                                                                                                              |
| **GitHub Copilot coding agent** | Actions secrets in a dedicated environment       | egress firewall on by default, widened by an allowlist variable; incompatible with self-hosted runners                                             |
| **Devin**                       | organisation- and session-scoped secrets manager | revocable, scoped per session — but **the agent can read the values**; guidance is a dedicated service account per platform                        |
| **Claude Code**                 | `.env`, shell environment, MCP                   | `permissions.deny` rules plus hooks, with **reported enforcement gaps**                                                                            |

Codex's phase separation is the strongest shipped model for a coding agent and it
is documented
([OpenAI](https://developers.openai.com/codex/cloud/environments),
[internet access](https://developers.openai.com/codex/cloud/internet-access)).
Copilot's default-deny egress is documented
([GitHub Docs](https://docs.github.com/en/copilot/responsible-use/copilot-cloud-agent),
[community #163374](https://github.com/orgs/community/discussions/163374)). The
Claude Code gap is a filed issue plus independent reproduction
([anthropics/claude-code#24846](https://github.com/anthropics/claude-code/issues/24846),
[Knostic](https://www.knostic.ai/blog/claude-loads-secrets-without-permission),
[The Register](https://www.theregister.com/2026/01/28/claude_code_ai_secrets_files/)):
deny rules never covered `grep -r`, a `cat` of a file the rule did not name, or a
script that opens a path it never spells out, and enforcement on `.env` itself is
reported as broken. **Any product that tells users "the agent is not allowed to
read `.env`" is describing an honour system.**

The 2026 table stakes this sets: a store outside the repo; values classified by
whether the agent may _see_ or merely _use_ them; default-deny egress; per-task
scope with revocation; masking in transcripts and logs.

### 1.6 Who ships a vault, and what their agent actually gets

| Product                      | Vault?                                                                    | What the agent gets                                                                                                                          | Confidence                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instinct**                 | Yes — a built-in Vault; a third of users stored account credentials in it | **Unknown.** On 2026-09-04 it announced just-in-time delivery through 1Password Unified Access instead of relying on its own store           | Product and announcement confirmed; **whether its agent ever holds plaintext is UNVERIFIED** — no spec published                                                      |
| **Hermes Agent**             | Local vault plus a pluggable secret source                                | Secrets claimed to be fetched from an external manager at load time, with per-variable provenance and a "password-blind" fill                | Product, author, date and MIT licence confirmed at [hermes-agent.org](https://hermes-agent.org/); **the secret-source detail is UNVERIFIED — secondary sources only** |
| **OpenClaw**                 | Opt-in **SecretRefs** with four resolvers: `env`, `file`, `exec`, `store` | Egress-time injection behind an "agent-access boundary"; plaintext is still permitted and still agent-readable                               | Confirmed in [docs.openclaw.ai/gateway/secrets](https://docs.openclaw.ai/gateway/secrets)                                                                             |
| **Composio**                 | Server-side custody, AES-256-GCM at rest                                  | **Never the token.** Connected-account fields are redacted at the API boundary and a proxy-execute path injects server-side                  | Confirmed in [token custody docs](https://docs.composio.dev/docs/security/token-custody)                                                                              |
| **Auth0 Token Vault**        | Yes — federated grants                                                    | A short-lived, connection-scoped access token per downstream call, then discarded; the refresh token and client secret never reach the agent | Confirmed in [Auth0 docs](https://auth0.com/docs/get-started/auth-for-genai)                                                                                          |
| **Arcade.dev**               | Auth orchestration rather than storage                                    | Per-user, per-scope tokens as a first-class primitive, with just-in-time approval prompts for high-risk actions                              | **Partially UNVERIFIED** — described by comparison sources; Arcade's own docs not fetched                                                                             |
| **Nango, Pipedream**         | Managed OAuth plus hosted execution                                       | Credentials injected server-side at call time                                                                                                | **UNVERIFIED** — secondary sources only                                                                                                                               |
| **1Password**                | Yes, the original                                                         | Names not values through MCP; a signed-in session rather than a password through Agentic Autofill                                            | Confirmed, section 1.2                                                                                                                                                |
| **ChatGPT agent**            | No vault                                                                  | "Takeover mode": the human types the password into a browser the model does not read                                                         | [OpenAI](https://openai.com/index/introducing-chatgpt-agent/); **the claim that the session cookie persists across tasks until sign-out is UNVERIFIED**               |
| **Anthropic**                | No credential vault product                                               | Deny rules and hooks in Claude Code; a partner ships the integration on top                                                                  | Confirmed                                                                                                                                                             |
| **Devin**                    | Yes — a secrets manager                                                   | Scoped and revocable, and **readable by the agent**                                                                                          | Confirmed via product docs                                                                                                                                            |
| **Perplexity Comet**         | No — delegates                                                            | A password-manager extension autofills without exposing data to the model context                                                            | Confirmed via [1Password](https://1password.com/blog/1password-now-available-in-comet-the-ai-browser-by-perplexity)                                                   |
| **Microsoft Entra Agent ID** | Identity, not secrets                                                     | Agents as first-class non-human identities under conditional access and privileged identity management; GA April 2026                        | Confirmed via [Microsoft Learn](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id)                                                    |
| **Okta**                     | Identity                                                                  | Short-lived governed tokens for agents instead of static API keys                                                                            | **Partially UNVERIFIED** — secondary sources                                                                                                                          |
| **Manus**                    | **Not found**                                                             | —                                                                                                                                            | **UNVERIFIED — stated plainly as not found rather than guessed**                                                                                                      |
| **Browser Use**              | **Not found** as a credential product                                     | —                                                                                                                                            | **UNVERIFIED**                                                                                                                                                        |

**The load-bearing datum is Instinct.** A personal-agent company valued at $2.5B,
with roughly a third of its users storing account credentials in its own Vault,
announced on 2026-09-04 that it would broker through 1Password Unified Access
rather than rely on that store
([explainX](https://www.explainx.ai/blog/instinct-1password-ai-agent-account-vaults-2026)).
No technical specification accompanied it, so the central question — does its agent
ever touch plaintext — is **open**, and the two public stories (own-vault custody,
partner brokering) are not obviously compatible.

**The pattern across the whole table:** the products that hold credentials hand
them to the agent (Devin, and any plaintext OpenClaw config); the products that
_never_ hand them over do not hold them so much as _use_ them on the caller's
behalf at a boundary the agent does not control (Composio at the API response,
Infisical at network egress, 1Password at the MCP result, Auth0 at the token
exchange). "Build a vault" is a 2025 answer. The 2026 answer is "hold references,
broker the call, and let somebody whose whole business is custody own custody."

---

## 2. The one honest caveat about every claim above

Five vendors say "the agent never sees the secret" and all five are telling the
truth — **at five different boundaries**. None of them prevents a secret that the
operator _deliberately_ injects into the agent's own process from being read by
that process. A design that mixes the two, brokering some calls and injecting
others, has the security of the weakest path, and users will not know which path a
given key took unless the product tells them. That is the argument for section 4.4.

---

## 3. The four design options

| Option                                                                       | Security property                                                                                                                                                       | Non-developer UX                                                                      | Build cost                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **(a) A broker makes the call** — egress proxy or server-side tool injection | The strongest available. The agent holds a placeholder, so a prompt injection exfiltrates nothing. **Degrades to nothing if broker and agent share a uid and a kernel** | Best. "Connect GitHub" once and never see a key                                       | **High.** A proxy, TLS handling, per-tool request rules, rotation. An MIT design exists — fork it |
| **(b) Scoped short-lived tokens per task**                                   | Very strong where the upstream supports OAuth or a token-exchange endpoint. Useless for a bare API key that has no exchange                                             | Good, though scope prompts are the hard part                                          | **Medium, and mostly not ours** — several vendors already do exactly this                         |
| **(c) Plaintext injection plus masking and audit**                           | Weak. Masking is post-hoc and `printenv` defeats it. Still strictly better than an unmanaged `.env`                                                                     | Familiar, zero new concepts                                                           | **Low**                                                                                           |
| **(d) Delegate to an external manager; hold references only**                | As strong as whichever manager the user chose. The product's own breach surface is empty — it holds strings like `op://vault/item/field`                                | Excellent for people who already run a password manager; a dead end for everyone else | **Lowest.** A resolver and a reference schema                                                     |

Read the table as a sequence rather than a menu. (d) is a prerequisite for (a):
you cannot substitute a placeholder at egress until something names which
credential the placeholder stands for, and that name is a reference. (b) is
somebody else's product. (c) is what every tool does today and is not, on its own,
worth shipping.

---

## 4. The recommended shape for the open-source app

**Build (d), then (a). Delegate (b). Never ship (c) alone.**

### 4.1 A reference layer, first

A secrets model whose stored values are **always references and never values**:

| Scheme                        | Resolves through                        | Notes                                                                                   |
| ----------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `op://<vault>/<item>/<field>` | the 1Password CLI                       | the format 1Password already documents, so an existing `.env` of references ports as-is |
| `env://<NAME>`                | the process environment of the resolver | the escape hatch, and the one scheme that is only as good as option (c)                 |
| `bws://<project>/<key>`       | Bitwarden Secrets Manager               | the second-most-likely manager a user already has                                       |
| `infisical://<path>/<key>`    | Infisical                               | pairs naturally with the proxy in 4.2                                                   |
| `cloud://<ref>`               | **reserved** for the hosted side        | the app must build, test and run with this scheme unimplemented — see 4.5               |

Four rules make this worth building rather than decorative:

1. **Resolution happens in a DorkOS-owned process that is not the agent's
   process.** A resolver the agent can call directly is `op read` with extra
   steps.
2. **Resolution order is explicit and per-field, never a search path.** A field
   names exactly one reference. Falling back from `op://` to `env://` on error is
   how a config silently starts using the wrong credential; a failed resolution is
   an error the user sees, not a fallback.
3. **The reference is the only thing that persists.** Resolved values live in
   memory for the duration of one call and are never written to disk, never
   logged, and never included in a transcript, a diagnostic bundle or a support
   export.
4. **Nothing resolvable goes in a marketplace manifest.** A package declares that
   it _needs_ a credential — a name, a kind, a human-readable purpose, optionally
   a documentation URL — and never where that credential lives. Manifests are
   published; references name a specific person's vault and item. The manifest
   declares the requirement, the install flow asks the user to bind it, and the
   binding is local state.

The payoff is immediate and larger than it sounds: a DorkOS config file becomes
safe to commit, screenshot, paste into an issue and hand to a support agent. It is
also what two independent open-source agents converged on without coordinating
(section 1.6), which is decent evidence that it is the natural shape.

### 4.2 A local egress proxy, second

Fork or vendor the MIT placeholder-substitution design (section 1.3) as a DorkOS
egress proxy. The agent's environment holds `__dorkos_<name>__`; the proxy
substitutes the resolved value on the way out.

**The threat model, stated in full, because a proxy that is described loosely is
worse than none:**

- **What it stops.** A prompt injection that reads the agent's environment, its
  process listing, its config files, or its own transcript, and sends what it
  found somewhere. All of those now contain placeholders.
- **What it does not stop.** The agent can still _use_ the credential, so an
  injection that persuades the agent to make a legitimate-looking request to the
  real upstream still succeeds. Substitution is confidentiality, not authorisation.
  Per-destination rules — this placeholder substitutes only on requests to this
  host — are what bound that, and they are part of the feature, not a later
  refinement.
- **Where it dies.** Same host, same uid: any code the agent can run can read the
  proxy's memory or its config. Ship the proxy under a separate OS user by
  default, document the failure loudly, and treat "same uid" as a degraded mode
  the UI names rather than a configuration detail.
- **What it costs.** TLS interception means a local certificate authority the user
  must trust, which is a real install-time ask and a real support burden. Any
  process on the machine that trusts that CA is now MITM-able by whatever holds its
  key.
- **What it must never do.** Log request bodies. The whole point is that the value
  exists in exactly one place for the duration of one connection.

### 4.3 Delegate token minting entirely

DorkOS should not build an OAuth issuer. That is a multi-quarter product with a
permanent compliance surface, and the connector-provider seam in the app already
routes through services that never return a token to the caller (section 1.6).
Anything those do not cover goes to a token-vault service rather than to a
first-party issuer.

Concretely: the reference layer's schemes cover **keys the user holds**. Tokens the
user does not hold — OAuth grants for a service an agent acts on — stay behind the
existing connector-provider port, whose contract is already "the agent gets an
action, not a token". These are two different mechanisms for two different things,
and conflating them is how a design ends up building an issuer by accident.

### 4.4 A three-type UI

Copy Cursor's classification verbatim in meaning, in DorkOS's own words:

| DorkOS type    | What the user is told                                                           | Mechanism                   |
| -------------- | ------------------------------------------------------------------------------- | --------------------------- |
| **Readable**   | "Your agent can read this value."                                               | option (c), plain injection |
| **Usable**     | "Your agent can use this to call the service, and cannot read it."              | option (a), the proxy       |
| **Setup only** | "Used while your project is being set up, then removed before your agent runs." | phase separation, see below |

Three requirements on that UI:

- **The type is visible at a glance wherever the credential appears**, not buried
  in a detail pane. A user's mental model of "the agent cannot see this" has to
  survive them adding a second key six weeks later.
- **Downgrades are explicit.** If the proxy is unavailable, or the destination has
  no rule, a **Usable** secret must not silently become a **Readable** one. It
  fails, and it says why.
- **The copy passes the non-developer test.** "Runtime secret" means nothing to
  the person this feature is for. The sentences in the middle column are the
  product.

### 4.5 Two more things worth the small effort

- **Phase separation, borrowed from Codex.** Secrets available to a setup phase and
  torn down before the agent phase begins is near-free for a task runner that
  already has phases, and it is what makes the third UI type real rather than
  aspirational.
- **`cloud://` is reserved, not implemented, here.** The hosted side owns custody
  for people with no password manager and no second machine — that is a genuine
  feature of a paid tier and it is the correct place for it, because a hosted
  broker is a different trust domain from the user's laptop by construction, which
  is exactly the property section 4.2 struggles to get locally. The open-source app
  must clone, build, test and run with that scheme unimplemented; the wire contract
  for it belongs in the public contract package like every other hosted surface.

### 4.6 What not to build

**Not a DorkOS password vault.** Custody is a cryptography-and-compliance business
with a permanent breach surface and no product differentiation, and the best-funded
company that tried it publicly handed custody to a password manager (section 1.6).
DorkOS should be the thing that _uses_ credentials correctly, not the thing that
_holds_ them.

---

## 5. Open questions

Each of these is genuinely open and should be answered before, not during,
implementation.

1. **Does the reference layer resolve on the server or in the CLI?** The app has
   surfaces that run in different processes, and "the resolver is not the agent's
   process" has a different answer in each.
2. **What happens on a machine with no password manager at all?** `env://` is the
   honest fallback and it is option (c). Whether the local product ships a
   plaintext store as a fourth scheme, or refuses, is a product decision with a
   security consequence.
3. **Is the local CA a blocker?** TLS interception may be too much to ask of the
   non-developer persona. A narrower first version — substitution only for
   first-party HTTP clients the app itself owns, no CA — reaches fewer calls and
   asks nothing.
4. **How does rotation propagate?** Rotating at the issuer and re-pointing the
   vault item leaves every reference unchanged, which is the whole appeal. But a
   long-lived agent holding a resolved value in memory does not notice, so
   resolution lifetime is a real design parameter.
5. **Does Instinct's agent ever hold plaintext? UNVERIFIED**, and the answer would
   change how confident section 4.6 should sound.
6. **Does the secret-source mechanism in Hermes Agent work as described?
   UNVERIFIED** against its repository — only secondary sources describe it, and it
   is the closest existing thing to section 4.1.
7. **What is Arcade's real scope model? Partially UNVERIFIED**; it matters only if
   section 4.3's delegation target list needs to be longer.

---

## Sources

- "does not read or return secret values to the agent" — [1Password on the Cursor Marketplace](https://1password.com/blog/the-1password-environments-mcp-server-is-now-on-cursor-marketplace); "only sees variable names" — [1Password Claude Code plugin docs](https://www.1password.dev/environments/claude-plugin)
- `op run` and `.env` files holding references — [1Password Developer](https://developer.1password.com/docs/cli/secrets-environment-variables)
- Unified Access GA 2026-03-17, Audit and runtime issuance still forthcoming — [1Password press](https://1password.com/press/2026/mar/1password-unified-access)
- "A credential that persists is already compromised" — [1Password × OpenAI Codex](https://1password.com/press/2026/may/openai-codex-integration)
- Agentic Autofill — [1Password Developer](https://www.1password.dev/agentic-autofill)
- Agent hooks: MIT, one hook — [1Password/agent-hooks](https://github.com/1Password/agent-hooks)
- Service-account vault scoping — [1Password Developer](https://developer.1password.com/docs/cli/reference/management-commands/service-account/)
- Claude Code deny-rule enforcement gap — [anthropics/claude-code#24846](https://github.com/anthropics/claude-code/issues/24846), [Knostic](https://www.knostic.ai/blog/claude-loads-secrets-without-permission), [The Register](https://www.theregister.com/2026/01/28/claude_code_ai_secrets_files/)
- Codex: secrets available only to setup scripts and removed before the agent phase; no agent internet by default — [OpenAI](https://developers.openai.com/codex/cloud/environments), [internet access](https://developers.openai.com/codex/cloud/internet-access)
- Cursor's three secret types — [Cursor docs](https://cursor.com/docs/cloud-agent/security-network)
- Copilot egress firewall default-on, allowlist variable, self-hosted-runner incompatibility — [GitHub Docs](https://docs.github.com/en/copilot/responsible-use/copilot-cloud-agent), [community #163374](https://github.com/orgs/community/discussions/163374)
- Infisical Agent Vault: MIT, placeholder substitution, separate-machine guidance — [GitHub](https://github.com/Infisical/agent-vault); Agent Proxy GA 2026-07-30 on all tiers — [PRWeb](https://www.prweb.com/releases/infisical-launches-agent-proxy-so-teams-can-ship-ai-agents-without-handing-over-real-credentials-302838708.html); "a single kernel exploit voids the entire threat model" — [Infisical](https://infisical.com/blog/credential-brokering-for-ai-agents)
- Composio custody, redaction at the API boundary, server-side proxy execution — [Composio](https://docs.composio.dev/docs/security/token-custody)
- Auth0 Token Vault — [Auth0](https://auth0.com/docs/get-started/auth-for-genai)
- OpenClaw SecretRefs, four resolvers, egress-time injection — [OpenClaw docs](https://docs.openclaw.ai/gateway/secrets), [Auth0 blog](https://auth0.com/blog/openclaw-credential-problem/)
- Hermes Agent: author, February 2026, MIT — [hermes-agent.org](https://hermes-agent.org/)
- Instinct's Vault and the 2026-09-04 1Password announcement — [explainX](https://www.explainx.ai/blog/instinct-1password-ai-agent-account-vaults-2026)
- Entra Agent ID GA April 2026 — [Microsoft Learn](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id)
- ChatGPT agent takeover mode — [OpenAI](https://openai.com/index/introducing-chatgpt-agent/)
- 1Password in Perplexity Comet — [1Password](https://1password.com/blog/1password-now-available-in-comet-the-ai-browser-by-perplexity)

## Gaps and limitations

- **Manus and Browser Use**: no credential-handling documentation was retrieved for
  either. Stated as not found rather than guessed.
- **Hermes Agent's secret source** and **Arcade's scope model**: described by
  secondary sources only; neither repository nor doc set was fetched directly.
- **Instinct's technical model**: no public specification exists. The central
  question is open.
- Several 2026-dated results in the search index are low-authority round-up blogs.
  Where a claim rests only on those it is marked UNVERIFIED above and should not be
  used to justify a design decision on its own.
- Third-party pricing was deliberately left out of this report. It changes, it is
  not a design input, and the design here does not depend on which manager a user
  pays for.

## Contradictions

1. **Do 1Password's agent hooks block `printenv` and `op read`?** A secondary
   source says yes; the repository documents one hook, which validates mounted
   `.env` files. **Trust the repository.** A product that wants blocking behaviour
   writes that hook itself.
2. **Do Claude Code `Read` deny rules work?** The documentation says yes; an open
   issue and independent researchers say `.env` is read anyway. Assume they do not,
   and layer a command hook.
3. **Does Instinct's agent see plaintext?** Its own Vault marketing implies
   custody; the 1Password partnership implies brokering. Unresolved, and the two
   stories are hard to reconcile.
4. **"The agent never sees the secret"** is claimed by five vendors and is true for
   all five at five different boundaries — API response, network egress, MCP tool
   result, token exchange, browser session. Section 2.
