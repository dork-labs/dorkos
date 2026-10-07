---
title: 'Agent computers: vendor login rules, zero-touch bootstrap, and the OpenAI sign-in program'
date: 2026-10-06
type: internal-architecture
status: active
tags:
  [
    agent-computer,
    bootstrap,
    enrolment,
    secrets,
    vendor-terms,
    openai,
    anthropic,
    codex,
    opencode,
    gemini,
    vision-202610,
  ]
---

# Agent computers: vendor login rules, zero-touch bootstrap, and the OpenAI sign-in program

**Date:** 2026-10-06. **Asked by:** Dorian, three linked questions about agents that live in "their own computer" (vision brief items 5 and 6, and its Open risks).

**How this was made.** Three research passes on the live web on 2026-10-06 (vendor terms, bootstrap patterns, the OpenAI program), plus a hand check of the five OpenAI pages the conclusions lean on hardest. It builds on our own reports from the same day: `research/20261006_agent-linux-desktop.md`, `research/20261006_secrets-vault-core.md`, `research/20261006_push-to-another-instance.md` (section 6, the subscription question), `research/20261006_competitive-analysis-2026-10-vision.md`, and the older `research/anthropic-tos-compliance.md`. Nothing from the private cloud repo is used here.

**About the quotes.** Most pages were read through a fetch tool that summarises. Text in quotation marks is what came back. It should match the vendor's wording closely but may not match to the character. Four OpenAI pages (the Terms of Use, two help articles, the interest form) returned HTTP 403, and that is marked where it matters. Vendor terms change often. Re-check every quote before anything ships.

---

## 0. The answer in one screen

**1. Can one person's AI login be reused across their own boxes, and can DorkOS hold it?**

| Vendor and login                                                       | Same person, several of their own boxes                                                                                                        | DorkOS stores it or injects it into boxes                                                                                                                                                                           | Verdict                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Anthropic, Claude subscription** (Pro, Max)                          | No device rule written down. Limits assume "ordinary, individual usage".                                                                       | **Forbidden.** "Developers may not collect, store, or intermediate Claude.ai credentials or session tokens." No carve-out for a vault on the person's own machine.                                                  | Each box signs in through Anthropic's own flow, inside the unmodified `claude` program. DorkOS never touches the token. The "sign-in drive" stays dropped.                                                                                 |
| **Anthropic, API key** (also Bedrock, Vertex, Foundry, and federation) | Allowed.                                                                                                                                       | **Allowed.** The terms name "a secrets manager, or machine image" as fine.                                                                                                                                          | Best fit for boxes. Inject at the edge, never inside.                                                                                                                                                                                      |
| **OpenAI, ChatGPT sign-in for Codex** (`auth.json`, device code)       | Allowed for your own machines, but only **one live copy per login**: "Do not share the same file across concurrent jobs or multiple machines." | **Grey** if DorkOS copies `auth.json` around. **Allowed** through Sign in with ChatGPT on the machine that ran the sign-in; a host holding refresh tokens for separate boxes is not documented (**Grey**).          | One sign-in per box, by device code or by Sign in with ChatGPT. Never one file shared by many boxes.                                                                                                                                       |
| **OpenAI, API key**                                                    | Allowed.                                                                                                                                       | Allowed.                                                                                                                                                                                                            | Inject at the edge.                                                                                                                                                                                                                        |
| **OpenCode**                                                           | Depends on the login inside it (below).                                                                                                        | Same.                                                                                                                                                                                                               | Its ChatGPT login is a named Sign in with ChatGPT open-source integration. Its GitHub Copilot login is officially allowed. Its OpenRouter key is a normal API key. Its Claude subscription plugins are forbidden; OpenCode itself says so. |
| **Google, Gemini CLI or Antigravity with a Google login**              | Only inside Google's own program.                                                                                                              | **Forbidden.** Third-party tools using the CLI's sign-in to reach Google's services "is a violation of applicable terms". Consumer Gemini CLI also stopped serving Google AI Pro, Ultra and free use on 2026-06-18. | Support Gemini only by API key or Vertex.                                                                                                                                                                                                  |

**2. Bootstrap, in five steps.** (Section 2.4 has the full design in seven steps; steps 6 and 7 there cover rotation and cloud.)

1. **Create.** The person clicks "Give this agent its own computer". DorkOS makes a one-time **enrolment token** (single use, expires in 10 minutes) and hands it to the new box from outside: a seed file, an env var, or cloud-init.
2. **Enrol.** On first boot, a small DorkOS helper inside the box makes its own keypair and trades the token for a **box certificate**. A local socket in the box then hands the agent **short-lived DorkOS tokens** for its account, tied to that certificate. The enrolment token is now dead. Renewal is automatic.
3. **Configure.** With those tokens, the box pulls its agent profile, memory, skills and settings from DorkOS. Nothing is typed into the box.
4. **Use secrets without holding them.** All traffic leaves through the DorkOS broker outside the box. The box holds placeholders; the broker swaps in the real API keys from the vault, only for the right websites, and records every use. Website passwords are filled by the host from outside, never handed to the agent.
5. **Sign in to the AI.** If the brain runs on an API key or DorkOS credits, it already works (step 4); Claude Code on credits in a box needs a separate agreement with Anthropic (section 1.1). If it runs on a person's subscription, the box starts the vendor's own sign-in and DorkOS shows it as a **"Sign in" card** in the app. The person clicks and approves on the vendor's site. For Claude and the device-code path, the login lands inside the box only; with Sign in with ChatGPT, the host keeps the long-lived token and the box gets short-lived ones. No one opens the box.

**3. The OpenAI program.** There are two doors, and the DorkOS app likely fits the open one.

- **Self-serve, open now, no contact needed:** "ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps." The DorkOS app is MIT-licensed and runs locally. OpenAI registers the app automatically during the person's first sign-in.
- **The interest form** (a waitlist), for "a paid or remotely hosted app": https://openai.com/form/sign-in-with-chatgpt-interest/. DorkOS Cloud and hosted agent computers would need this door.
- Dorian decided on 2026-10-06 not to contact OpenAI. The self-serve door does not need contact. A short draft for the form is in **Appendix A**, for Dorian to review and send himself if and when he chooses.

---

## 1. Vendor policy, vendor by vendor

Labels: **Allowed** (written permission), **Grey** (not addressed, or permitted only with conditions we cannot fully check), **Forbidden** (written prohibition).

### 1.1 Anthropic (Claude Code)

The rules live on one page: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (accessed 2026-10-06).

- **Forbidden:** "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- **Forbidden:** "Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens ... sign-in to a Claude account must complete through Anthropic's own flow."
- **Allowed (API keys only):** "This does not restrict how customers provision and manage their own API keys or third-party inference provider credentials, for example, configuring an API key in a development environment, secrets manager, or machine image for use by the customer's own authorized users." Note that this carve-out names API keys, not subscription tokens.
- **Conditions for any product that runs Claude Code:** "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms". A DorkOS box image with Claude Code baked in counts, **local or cloud**. The same section: "Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential." So Claude Code on DorkOS credits inside a box needs a separate agreement with Anthropic; this report does not cover whether one exists.
- **Allowed with conditions (hosting):** the rule does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". The same page says a platform that preinstalls or runs Claude Code must accept the Commercial Terms, must not modify the binary, and "may not pay for, resell, or intermediate Claude usage on their end users' behalf."
- **Usage limits:** "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- **Enforcement:** "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- **Agent SDK** ([overview](https://code.claude.com/docs/en/agent-sdk/overview)): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." DorkOS drives the Agent SDK today; the vision brief already lists this as an accepted risk.
- **`claude setup-token`** ([authentication](https://code.claude.com/docs/en/authentication)): makes "a one-year OAuth token" for "CI pipelines, scripts, or other environments where interactive browser login isn't available". "It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate." It "can only make model requests". A person pasting their own token into their own CI is fine. DorkOS holding it and injecting it is "store, or intermediate".
- **Consumer Terms** ([link](https://www.anthropic.com/legal/consumer-terms), effective 2025-10-08): no automated access "except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it". You may not share credentials or "make your Account available to anyone else."
- **Paused billing change** ([support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), accessed 2026-10-06): "We're pausing the changes ... For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits." No restart date.
- **No device-code login.** Claude Code's headless options are: paste the login code from the browser back into the terminal ("common in WSL2, SSH sessions, and containers"), `setup-token`, an API key or `apiKeyHelper`, or workload identity federation. A device-code request ([issue #22992](https://github.com/anthropics/claude-code/issues/22992), opened 2026-02-04) is still open.
- **New and useful:** [Workload identity federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) lets a workload trade a signed identity token (from GitHub Actions, Kubernetes, SPIFFE or a custom issuer) for a short-lived API token, 1 hour by default. Claude Code reads it. It is API billing, not a subscription.

**Verdict.** Sharing one Claude subscription login across many boxes through DorkOS is out. Each box must sign itself in, through Anthropic's own screens, inside the unmodified program. That confirms the competitive analysis: drop the sign-in drive.

### 1.2 OpenAI (Codex and ChatGPT)

- **Headless sign-in is documented** ([Codex auth](https://learn.chatgpt.com/docs/auth), accessed 2026-10-06): "prefer device code authentication (beta)" and "run `codex login --device-auth`". You may also "Copy `~/.codex/auth.json` to `~/.codex/auth.json` on the headless machine". "Treat `~/.codex/auth.json` like a password: it contains access tokens." "Don't commit it, paste it into tickets, or share it in chat." Device-code login must first be switched on in ChatGPT settings ([issue #9253](https://github.com/openai/codex/issues/9253)).
- **One live copy per login** ([CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)): "The right way to authenticate automation is with an API key." ChatGPT sign-in on a runner is for "trusted private infrastructure" only. "Use one `auth.json` per runner or per serialized workflow stream." "Do not share the same file across concurrent jobs or multiple machines." "Do not use this workflow for public or open-source repositories." Part of the reason is technical: refresh tokens rotate, so two copies that both refresh break each other.
- **Account sharing:** the Terms of Use say "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account." ([Terms](https://openai.com/policies/row-terms-of-use/); the page returned 403, so this quote is from the search index and its date is unconfirmed.) Moving your own login between your own machines is not sharing with another person.
- **Sign in with ChatGPT** (launched 2026-09-29): Plus and Pro users can let apps use their plan, each app capped at a share of weekly usage that the person picks (10% to 100%) in ChatGPT settings ([learn page](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)). Section 3 covers the program. The key point for this question: it is OpenAI's sanctioned way for an app to hold a person's plan tokens. The [open-source sign-in page](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) tells the app to write them "atomically with owner-only permissions (`0600` on Unix), and never commit or log them."
- **Codex can take its token from the host app.** The Codex app-server protocol already has a request named `account/chatgptAuthTokens/refresh`, where Codex asks its host app for a fresh ChatGPT access token after a 401 (see `apps/server/src/services/runtimes/codex/app-server/protocol/schema-snapshot.json`). OpenAI's [Codex app-server page](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) for Sign in with ChatGPT says to pass the access token in as `ACCESS_TOKEN`: "No separate Codex sign-in is required." The host refreshes it and restarts app-server. So with Sign in with ChatGPT, the long-lived refresh token can stay outside the box while the box only ever gets a short-lived access token.

**Verdict.** One person may use their ChatGPT login on their own boxes, but never one file on many boxes at once. Through Sign in with ChatGPT, DorkOS may hold the tokens, because that is what the program is for. Copying `auth.json` around through DorkOS outside that program is grey.

### 1.3 OpenCode

- **Where logins live** ([providers docs](https://opencode.ai/docs/providers/), updated 2026-10-06): keys added with `/connect` "are stored in `~/.local/share/opencode/auth.json`."
- **ChatGPT Plus or Pro:** OpenCode offers it as a sign-in choice. OpenAI staff said on 2026-01-09 that they were "working with OpenCode to allow Codex users to use their Codex subscriptions and usage limits in OpenCode directly" ([post](https://x.com/thsottiaux/status/2009742187484065881)), and later named OpenCode among the 16 Sign in with ChatGPT partners ([post](https://x.com/thsottiaux/status/2105006253986738615)). The partner list on [learn.chatgpt.com](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) names OpenCode among its "Open-source integrations", next to OpenClaw, Pi and T3. **Allowed.**
- **GitHub Copilot:** "GitHub Copilot now supports OpenCode" ([changelog, 2026-01-16](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/)): paid Copilot users "can now authenticate into OpenCode using their Copilot credentials", with "existing terms apply". **Allowed.**
- **OpenRouter** ([terms](https://openrouter.ai/terms), updated 2026-08-31): you are "responsible for all activity and charges under its account or API Credentials, whether or not authorized by you", and may not sell "or otherwise transfer the access". **Allowed** on your own boxes; never resold.
- **Claude subscription inside OpenCode:** OpenCode's own docs: "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this." Those plugins are no longer bundled from v1.3.0. **Forbidden.**

**Verdict.** Treat OpenCode as a wrapper. Its OpenAI and Copilot logins follow the same one-sign-in-per-box rule as above. OpenRouter keys are plain API keys and go through the broker. Never offer a Claude subscription inside it.

### 1.4 Google (Gemini CLI and Antigravity)

- **Third-party use of the CLI's login is forbidden** ([Gemini CLI terms and privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md), accessed 2026-10-06): "Directly accessing the services powering Gemini CLI ... using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies." The penalty can be "suspension or termination of your account."
- **Consumer Gemini CLI is retired** ([discussion #27274](https://github.com/google-gemini/gemini-cli/discussions/27274), 2026-05-19): "On June 18, 2026, Gemini CLI will stop serving requests for Google AI Pro and Ultra, as well as those using it free of charge." Paid API keys and Code Assist Standard or Enterprise continue. The successor, Antigravity CLI (`agy`), is closed source; we did not find its terms on credential reuse.
- **API keys and Vertex** fall under the [Gemini API terms](https://ai.google.dev/gemini-api/terms) and Google Cloud terms, and are fine to use from any of your own machines.

**Verdict.** No Google consumer login in DorkOS. Gemini by API key or Vertex only, through the broker.

### 1.5 Does a shared vault entry for a shared login count as "storing or intermediating"?

The question: the person's own login, kept in a DorkOS vault on the person's own machine, injected into the person's own boxes.

- **Anthropic: yes, it counts.** The ban is on "developers" who "collect, store, or intermediate" Claude.ai credentials. DorkOS is the developer and the vault is DorkOS code, wherever it runs. The only carve-out for storage ("a secrets manager, or machine image") is written for API keys and pointedly not for subscription tokens. Forbidden. Do not build it.
- **OpenAI: depends on the path.** Through Sign in with ChatGPT, the app holding tokens is the sanctioned design. Outside it, a vault copying `auth.json` into several boxes breaks the "one copy per machine" rule even before the terms question.
- **Google: yes, forbidden.** The ban covers third-party software using the CLI's sign-in at all.
- **API keys (Anthropic, OpenAI, OpenRouter, Google API):** no. Storing and injecting your own key is explicitly fine. You are liable for its use.
- **No vendor addresses "user-controlled vault on the user's machine" directly.** Our reading is that the vendors look at who wrote the code that holds the token, not where the disk is.

---

## 2. Bootstrapping an agent's own computer

### 2.1 The problem

A fresh box knows nothing. It has no identity, no DorkOS key, no settings and no AI login. The person must never have to open the box and type into it. Everything comes from outside, set up in the DorkOS app.

### 2.2 What everyone else does

Every mature system splits bootstrap into two moves: **deliver something short-lived and single-use from outside**, then **trade it inside for working credentials that renew themselves**. The newer agent sandboxes add a third: **the agent never holds the real secret at all.**

| Pattern                                                                                                                                                                                                                                                                                                                                                                                                                | What arrives from outside                                             | What it is traded for                                                       | Lesson for DorkOS                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [cloud-init](https://cloudinit.readthedocs.io/en/latest/explanation/format.html) user-data, NoCloud seed                                                                                                                                                                                                                                                                                                               | A config file at first boot                                           | Nothing; it just runs                                                       | Good delivery truck for a one-time token. Never for long-lived secrets: user-data stays readable from inside for the box's life ([AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html)). Block `169.254.169.254` from inside agent boxes. |
| [Kubernetes bootstrap tokens](https://kubernetes.io/docs/reference/access-authn-authz/bootstrap-tokens/)                                                                                                                                                                                                                                                                                                               | A one-time token with an expiry                                       | A client certificate that rotates itself                                    | The exact shape we want: token, then certificate, then the token is useless.                                                                                                                                                                                  |
| Kubernetes [projected service-account tokens](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#serviceaccount-token-volume-projection)                                                                                                                                                                                                                                              | Nothing secret; the platform vouches                                  | A JWT bound to one audience, refreshed at 80% of life                       | Short-lived, audience-bound tokens that renew without anyone noticing.                                                                                                                                                                                        |
| [SPIFFE/SPIRE](https://spiffe.io/docs/latest/spire-about/spire-concepts/)                                                                                                                                                                                                                                                                                                                                              | A one-time join token (default 10 minutes), or platform proof         | Short-lived certificates (about 1 hour), rotated at half-life               | Join tokens are for boxes with no platform identity, like a VM on a laptop. That is our local case.                                                                                                                                                           |
| [GitHub Actions OIDC](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)                                                                                                                                                                                                                                                 | Nothing stored; the job asks for a signed token                       | Short-lived cloud credentials, matched on claims                            | The trust rule lives with the receiver. DorkOS can be an issuer like this.                                                                                                                                                                                    |
| [Fly.io](https://fly.io/docs/security/openid-connect/) secrets and OIDC                                                                                                                                                                                                                                                                                                                                                | Encrypted env vars at boot; a local socket that hands out OIDC tokens | Cloud roles                                                                 | A local socket inside the box that hands out short-lived tokens is a clean API.                                                                                                                                                                               |
| [Codespaces secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces), [Dev Containers](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials)                                                                                                                                                                   | Env vars at start; the host's git helper and ssh-agent forwarded in   | n/a                                                                         | Git without a token on disk: a helper that asks the host per push.                                                                                                                                                                                            |
| [Vault AppRole with response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping)                                                                                                                                                                                                                                                                                                          | A single-use wrapping token                                           | A renewing Vault token                                                      | If unwrapping fails because someone already did it, raise the alarm.                                                                                                                                                                                          |
| [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/configuration/credentials/), [Vercel Sandbox](https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox), [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/), [Infisical Agent Vault](https://github.com/Infisical/agent-vault), [iron-proxy](https://github.com/ironsh/iron-proxy) | A placeholder value                                                   | The real key, swapped in by a proxy outside the box, for allowed hosts only | "The real credential stays on the host ... the sandbox sees only a sentinel value" (Docker). This is our "use, don't read".                                                                                                                                   |
| [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)                                                                                                                                                                                                                                                                                                                                       | Nothing                                                               | A proxy outside the VM adds the GitHub credential                           | "Your GitHub credentials stay encrypted on Anthropic's servers and never enter a session's VM."                                                                                                                                                               |
| [Claude Managed Agents vaults](https://platform.claude.com/docs/en/managed-agents/vaults)                                                                                                                                                                                                                                                                                                                              | "an opaque placeholder"                                               | "substituted with the real secret at egress"                                | Two documented limits we inherit: request signing (AWS SigV4) breaks, and "substitution is outbound only", so a token returned by an exchange lands in the box in the clear. Rotation reaches running sessions without a restart.                             |
| [Codex cloud environments](https://developers.openai.com/codex/cloud/environments)                                                                                                                                                                                                                                                                                                                                     | Secrets for the setup script                                          | Nothing; "secrets are removed before the agent phase starts"                | Setup-only secrets: install with them, then take them away.                                                                                                                                                                                                   |
| [RFC 8628 device code](https://www.rfc-editor.org/rfc/rfc8628)                                                                                                                                                                                                                                                                                                                                                         | n/a                                                                   | A login completed by a person on another device                             | The box shows a link and a short code; the person approves elsewhere. `verification_uri_complete` is made to be shown as a link or QR code.                                                                                                                   |

E2B, Modal and Daytona pass env vars straight into the box, visible to the agent. We found no shipped credential proxy for them (E2B [#1160](https://github.com/e2b-dev/E2B/issues/1160) is closed with no visible result; unverified).

### 2.3 What DorkOS already has

- **RFC 8628 device code for linking to DorkOS Cloud:** `POST /v1/device/code` and `/v1/device/token` in `packages/cloud-api/src/session.ts` and `routes.ts`. Managed remote access (DOR-2763) adds an enrolment ceremony on top.
- **Delegated vendor login:** `apps/server/src/services/runtimes/connect/delegated-login.ts` already runs `claude auth login` and `codex login` without a terminal and watches for success. Its header says: "DorkOS never reimplements a vendor's OAuth."
- **A dormant egress broker:** `apps/server/src/services/browser/egress/broker/` (its README says app startup does not mount it). The vault report picks it as the home for placeholder swapping.
- **Base-URL inference routing for credits:** `apps/server/src/services/core/cloud/credits-inference.ts`. The same trick lets a broker add an API key per request.
- **Codex host-owned tokens:** the `account/chatgptAuthTokens/refresh` request in the Codex app-server protocol (section 1.2).
- **Per-account vendor homes:** `CLAUDE_CONFIG_DIR` and `CODEX_HOME` per account, so each box keeps its own login directory.

### 2.4 The design

Words used below: the **box** is the agent's own computer. The **host** is the DorkOS server that owns it (the laptop locally, or a DorkOS Cloud machine). The **box helper** is a small DorkOS program baked into the box image. The **broker** runs on the host, outside the box, and is the box's only way out to the internet.

#### Step 1. Create: a one-time enrolment token

1. The person (or an agent allowed to) clicks **"Give this agent its own computer"** and picks local or cloud.
2. The host creates an enrolment record: agent id, box id, the image digest, an expiry of **10 minutes**, single use. It makes a random **enrolment token** and stores only its hash.
3. The host starts the box and hands it the token **from outside**:
   - local VM: a NoCloud seed or a file in a read-only mount;
   - container: an env var or a mounted file;
   - cloud: cloud-init user-data.
4. The token is useless on its own after 10 minutes, after first use, or if the box id it was minted for does not match.

Prior art: Kubernetes bootstrap tokens, SPIRE join tokens, Vault wrapped secret ids.

#### Step 2. Enrol: the box proves itself and gets its keys

1. On first boot, the box helper makes its own **keypair** (the private key never leaves the box) and sends the host the enrolment token and the public key.
2. The host takes the box's identity from the connection itself (the VM socket, the container id, or the private address the host handed out), never from anything the box says about itself. It checks the hash of the token, the expiry, single use, and that the token was minted for that box. Requests from the open internet are refused for local boxes. Then it burns the token.
3. The host returns a **box certificate** (about 24 hours, renewed by the helper at half-life) and registers the box as the runner for that agent (the lease from the push report).
4. **The agent's DorkOS API key.** The vision brief says each account has its own key, in its own vault, never shared. The box never holds that long-lived key. Instead the box helper serves a local socket that hands the agent a **short-lived DorkOS token** (about 1 hour), minted by the host against the box certificate and limited to that agent's access level. The DorkOS CLI and MCP inside the box read it from the socket, like Fly's `/.fly/api` socket or a Kubernetes projected token. The agent, or a prompt injection, can read this token. So it is bound to the box certificate (mutual TLS or DPoP, a proof that only the box's key can make), and the host accepts it only over the box's private link. A stolen copy is useless anywhere else.
5. If a second redemption of the same token is ever tried, that is an alarm: an attacker may have won the race. Quarantine both the enrolled box and the one that tried, record it, and require a fresh enrolment (Vault's wrapped-token idea).

#### Step 3. Configure: pull, don't type

With its short-lived token, the box helper pulls everything else from the host:

- the agent's profile, role and responsibilities, `AGENTS.md`, memory, skills and plugins (Harness Sync already projects these for each runtime);
- runtime settings, room memberships and schedules;
- the list of secrets the agent may **use** (names and allowed websites, never the values);
- for a moved agent, its home volume (the push report's bundle).

Setup-only secrets (for example, a token to install a private package) follow Codex's rule: available to the setup script, then removed before the agent starts.

#### Step 4. Secrets and the vault: use, don't read

This is the vault report's design, applied to boxes:

- The box's only way out is the broker. The broker's certificate authority is baked into the image; its private key stays on the host.
- The agent sees **placeholders**, for example `OPENROUTER_API_KEY=dork-placeholder-7f3a`. When a request leaves for an allowed website, the broker swaps in the real key from the vault and records the use in the audit trail.
- **Website logins** are filled by the host over the browser's control channel, matched to the exact website. **Git** uses a helper that asks the host per push; no token sits on disk.
- **Vault grants:** an agent gets "Use" on a secret by default (the broker uses it for the agent), "Read" only if a person chooses (the value is wrapped to the agent's key). Sharing a secret with another agent adds a grant; it never copies a value.
- **Known limits, said plainly:** request signing like AWS SigV4 breaks behind a placeholder; a token that comes back in a response lands in the box in the clear; an agent can still read a password field after it is filled; once a vendor login lands in the box (`auth.json`, the `.claude` folder), anything in the box can read it; and with Sign in with ChatGPT the short-lived access token sits in the box's environment, readable by the agent until it expires. The docs must not over-claim.

#### Step 5. Sign in to the AI: the vendor's own flow, shown in the app

The rule from section 1: **for subscriptions, the login must be made inside the box by the vendor's own program, and DorkOS must never hold it** (except OpenAI's sanctioned program). For API keys, the broker does it.

| Brain and payment                                                             | How the box gets it                                                                                                                                                                                             | What the person does                                                                                                          | DorkOS ever sees the credential?                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any brain on **DorkOS credits**                                               | The broker points the runtime's base URL at the host, which adds the credit token per request (today's credits path)                                                                                            | Nothing. **For Claude Code, see the condition in section 1.1:** credits inside a box need a separate agreement with Anthropic | Yes, but it is DorkOS's own token, never the person's login                                                                                                                                                                                       |
| Any brain on the person's **API key** (Anthropic, OpenAI, OpenRouter, Gemini) | A placeholder in the box; the broker swaps in the real key                                                                                                                                                      | Nothing (the key is already in their vault)                                                                                   | Yes, the key. Explicitly allowed for API keys                                                                                                                                                                                                     |
| Claude Code on **Anthropic API with federation**                              | The host acts as an OIDC issuer; Claude Code trades the box's token for a short-lived Anthropic token ([WIF](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation))                   | One-time setup of a federation rule in the Anthropic Console                                                                  | No stored key at all. Needs a public issuer URL or the inline key-set mode                                                                                                                                                                        |
| Codex on a **ChatGPT plan** (best: Sign in with ChatGPT)                      | The DorkOS app does Sign in with ChatGPT for this box, with the box's own host id. The host keeps the refresh token; the box gets only short-lived access tokens through `ACCESS_TOKEN` and the refresh request | Clicks "Continue with ChatGPT", approves once per box                                                                         | Yes, the refresh token, inside OpenAI's program. Note: the docs describe the app holding tokens on the machine that signed in; a host holding them for separate boxes is not documented (Grey). Local app only until the hosted waitlist says yes |
| Codex on a **ChatGPT plan** (fallback: device code)                           | The box helper runs `codex login --device-auth` inside the box. DorkOS reads the link and short code it prints and shows a **Sign in card**                                                                     | Opens the link, types or confirms the code on chatgpt.com. Must have device-code login switched on in ChatGPT settings        | No. The token is made inside the box and stays there                                                                                                                                                                                              |
| Claude Code on a **Claude subscription**                                      | The box helper starts `claude auth login` inside the box. DorkOS shows the sign-in link on a card. Anthropic's page then shows a code, which the person pastes into a **terminal view of the box** in the app   | Clicks the link, signs in on claude.ai, pastes the code into the box's own terminal                                           | No. The code goes into the unmodified program, through a terminal view, like SSH                                                                                                                                                                  |
| OpenCode                                                                      | Same as its login type: OpenRouter or other keys through the broker; ChatGPT through OpenCode's own sign-in in the box; Copilot through GitHub's device flow in the box                                         | Same as above                                                                                                                 | Same as above                                                                                                                                                                                                                                     |
| Gemini                                                                        | API key or Vertex through the broker                                                                                                                                                                            | Nothing                                                                                                                       | Yes, the key                                                                                                                                                                                                                                      |

**Why the Claude path uses a terminal view, not a paste box.** A DorkOS form that accepts the code and writes it into the program is DorkOS code carrying part of the Claude sign-in. That is close to "intermediate". A terminal view only carries keystrokes, as SSH does, and leaves the sign-in to "complete through Anthropic's own flow." It is slightly more defensible, but the difference is thin: the code travels through DorkOS either way, and pasting a code into the unmodified program is Anthropic's own flow whatever carries the keystrokes. It is still grey for the hosted case, because a DorkOS Cloud box is "a platform hosting Claude Code" and needs the Commercial Terms conditions met. If Claude Code ships device-code login (issue #22992), switch to the same card as Codex.

**One sign-in per box, every time.** Never copy a login from one box to another, and never let two boxes share one. OpenAI's docs forbid it for `auth.json`, refresh tokens break if two copies refresh, and Anthropic's terms forbid DorkOS moving the token. When an agent moves, the push report's rule holds: sign in again on the new runner. After the first sign-in, the person's browser is already logged in, so each new box usually costs one or two clicks.

**Phishing care.** A sign-in card is the kind of thing an attacker fakes. The card must name the agent and the box, say which vendor it is for, appear only in the person's own DorkOS app, and expire with the vendor's code. Codex itself warns: "Device codes are a common phishing target. Never share this code." A compromised box could also print an attacker's device code, and the person would approve a login that hands their session to the attacker. So the host shows a card only for a sign-in the person started from the app, checks that the link points at the vendor's exact sign-in domain, and shows that domain plainly on the card.

#### Step 6. Rotation, expiry and revocation

| Thing                    | Lifetime                                                                          | How it renews                                                                                               | How to kill it                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enrolment token          | 10 minutes, single use                                                            | Never; make a new one                                                                                       | It dies on use                                                                                                                                                                 |
| Box certificate          | about 24 hours                                                                    | Box helper renews at half-life over the private link                                                        | Revoke the box: the host stops renewing and rejects the certificate. The broker cuts the box's traffic at once                                                                 |
| Short-lived DorkOS token | about 1 hour                                                                      | Socket mints a new one                                                                                      | Same as the box, or change the agent's access level, which applies at the next mint                                                                                            |
| Vault secrets            | Set by the person                                                                 | Rotate in the vault; the broker uses the new value on the next request, no restart (as Managed Agents does) | Remove the grant                                                                                                                                                               |
| Vendor logins in the box | Vendor's rules (Codex refreshes about every 8 days; a Claude `/login` can expire) | The vendor program refreshes itself                                                                         | Sign out in the box (DorkOS can run the vendor's own sign-out command), or revoke on the vendor's site. Show a clear "Paused: sign-in expired" state with a fresh Sign in card |

#### Step 7. Local and cloud are the same

The same seven steps run locally and in DorkOS Cloud. Only the delivery truck in step 1 changes (a seed file versus cloud-init) and who owns the host. Two cloud-only differences:

- In the cloud, the "private link" in step 2 is a network the host controls, so the enrolment check should also confirm the box id against the cloud provider's own record of the machine.
- **Hosted subscription logins carry more terms risk** than local ones (Claude: Commercial Terms conditions; OpenAI: Sign in with ChatGPT's hosted waitlist). Until those are settled, default cloud boxes to the person's own API key. (The Linux-desktop report also offered credits; for Claude Code that needs the agreement in section 1.1.)

---

## 3. The OpenAI program

### 3.1 What it is

"Sign in with ChatGPT" lets a person with ChatGPT Plus or Pro use their plan inside another app, up to a weekly cap they choose for that app. Launched at DevDay on 2026-09-29 with 16 partners. Docs hub: https://developers.openai.com/siwc.

There are three tracks: sign-in on a website, sign-in in a ChatGPT plugin, and plan usage in open-source apps (`/siwc/token-sharing-open-source`). There is also an identity-only sign-in (no plan usage) for websites.

### 3.2 The two doors

**Door 1: self-serve, for open-source and local apps. Open now.**

- OpenAI's cookbook ([link](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), hand-checked 2026-10-06): "ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps."
- No form. On the first sign-in, the app uses `client_id=dynamic_agent_client` and its real name; "OpenAI registers the client during this flow" and returns a client id starting `oaiapp_` for the app to reuse.
- Several open-source projects adopted it in the past week (for example [hermes-agent #128880](https://github.com/NousResearch/hermes-agent/issues/128880)).
- The cookbook gives no definition of "open-source", and no publication date.

**Door 2: the interest form, for commercial or hosted apps. A waitlist.**

- The same cookbook: "If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users."
- [Request a client ID](https://developers.openai.com/siwc/request-client-id) (hand-checked 2026-10-06): "Sign in with ChatGPT is currently offered to a select group of commercial partners." Access is by the **interest form**: https://openai.com/form/sign-in-with-chatgpt-interest/ (403 when fetched).
- The form fields, from a search snippet only: work email, first and last name, company name, website, job title (optional), the capabilities you want, and which products would use it.
- No published review criteria, timeline or security checklist. The website guide adds: "Contact your OpenAI representative to join the waitlist."

### 3.3 Which door is DorkOS?

- **The DorkOS app** (MIT, runs on the person's own computer, free with no account): Door 1 fits the words "open-source projects" and "run locally". No contact with OpenAI is needed, which matches Dorian's 2026-10-06 decision.
- **Grey edge:** DorkOS also has a paid, optional cloud layer. Door 1's wording is about the app, and the app is free and local, but OpenAI could read "paid" broadly. Using plan usage only in the local app, never routed through DorkOS Cloud, keeps us on the clear side.
- **DorkOS Cloud and hosted agent computers:** Door 2. "Remotely hosted" is explicit. A self-hosted-VM guide exists ([link](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)), but it is for "an open-source app on a remote virtual machine" that the person runs, and says "Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available." It does not cover a company hosting the VM.

### 3.4 Rules we would have to follow

From the [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) and the open-source track pages:

- Button text: "Continue with ChatGPT". A one-time welcome note: "Eligible usage in this app uses your ChatGPT plan." A "Using ChatGPT plan" label near the model picker. A "Manage usage" link to https://chatgpt.com/settings/usage, which becomes the main action when the cap is hit.
- PKCE on every sign-in. A stable, opaque host id per machine ("not an email, user ID, or other user-identifying value"); in our design, one per box. Tokens saved with owner-only permissions; refresh tokens rotate on every refresh.
- Model calls only through the public Responses API with `store: false` and `stream: true`; "do not point it at ChatGPT's `backend-api` endpoints." No image generation, file search, Code Interpreter, hosted MCP, audio or video. When the cap is hit, requests fail with `subscription_sharing_usage_limit_exceeded`.
- For Codex: pass the token as `ACCESS_TOKEN`, refresh it in the host, restart app-server.
- **Licence trap:** OpenAI's [DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit) is under a "Noncommercial License". Do not copy its code into DorkOS. Write our own client against the documented protocol. Read the licence text before deciding anything else about it.

### 3.5 What to do

1. **Build Door 1 into the local app** for Codex (and check whether OpenCode's own sign-in already covers OpenCode). No contact with OpenAI needed.
2. **Treat it as the preferred ChatGPT path** in the bootstrap design (section 2.4, step 5), with device code as the fallback.
3. **Door 2 only when DorkOS Cloud hosts agent computers.** The draft is in Appendix A. Sending it is Dorian's call, and it would reverse his "don't contact OpenAI" decision for this one program. The competitive analysis already suggested revisiting that decision for OpenAI only.

---

## 4. Open questions and risks

- **Claude subscription in hosted boxes** stays grey even with a terminal-view sign-in. It needs the Commercial Terms conditions met, and ideally written confirmation from Anthropic. Dorian has decided not to ask for now; default cloud boxes to the person's own API key. Claude Code on credits in any box (local or cloud) needs its own agreement with Anthropic.
- **The Agent SDK risk** (DorkOS drives Claude Code through the SDK on a person's plan) is unchanged by anything here and remains the brief's accepted risk.
- **Holding Sign in with ChatGPT refresh tokens on the host** for separate boxes is our design, not something OpenAI documents. Ask in the Door 2 application, or fall back to one sign-in inside each box.
- **Door 1's "open-source" and "paid"** are undefined. If OpenAI tightens it, the device-code fallback still works.
- **Antigravity CLI's terms** on credential reuse were not found.
- **"One live copy per login"** means a person with five agent computers signs in five times. That is the honest cost of staying inside the rules; the app should make each one a single click.
- **Quotes were read through a summarising fetch.** Re-check the exact wording of every quote in section 1 before any of it goes into public docs.

---

## Appendix A. Draft for the Sign in with ChatGPT interest form

For Dorian to review, change and send himself, only if and when he decides to. Field names follow the search snippet of the form, which we could not open directly (HTTP 403). Plain and short on purpose.

**Company name:** 144 Studio, LLC (DorkOS)

**Website:** https://dorkos.ai

**Work email, name, job title:** Dorian Collier, founder. (Fill in the work email you want OpenAI to use.)

**Which products would use it:** DorkOS, an open-source (MIT) workspace for people and AI agents. It runs on the person's own computer. Optional: DorkOS Cloud, a paid hosted layer that will run agents on their own Linux computers in the cloud.

**Which capabilities you want:** ChatGPT plan usage (Codex and Responses API), and Sign in with ChatGPT for identity.

**Tell us about your use case:**

> DorkOS is an open-source workspace where people and AI agents work together in DMs and channels. It runs Codex, Claude Code and OpenCode as each agent's brain, on the person's own computer.
>
> Today DorkOS runs Codex's own `codex login`, so people sign in to Codex with their own ChatGPT account. We want to do that the way OpenAI intends: through Sign in with ChatGPT, with your branding, the per-app weekly cap, and the "Manage usage" link.
>
> We plan to adopt the self-serve path for the local, open-source app. We are asking about the hosted case: agents that run on their own computer in DorkOS Cloud, each signed in by the person through your flow, one sign-in per agent computer, the refresh token kept outside the agent's computer, only short-lived access tokens inside it, and nothing shared between computers or people.
>
> What we will do: follow your UI rules, call only the Responses API, keep tokens with owner-only permissions, never log them, and show people exactly which agent used their plan. What we will not do: resell or pool plan usage, share one person's tokens with another person, or call any private ChatGPT endpoint.
>
> DorkOS is pre-launch, aiming for mid to late November 2026. A small company (144 Studio, LLC), open source on GitHub.

**Expected weekly users (if asked):** under 1,000 at launch. (Adjust to the real number when you send it.)

---

## Sources

**Anthropic:** [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) · [Claude Code authentication](https://code.claude.com/docs/en/authentication) · [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) · [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) · [Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) · [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) · [Managed Agents vaults](https://platform.claude.com/docs/en/managed-agents/vaults) · [Workload identity federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) · [Device-code request #22992](https://github.com/anthropics/claude-code/issues/22992)

**OpenAI:** [Codex auth](https://learn.chatgpt.com/docs/auth) · [Codex CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth) · [Codex GitHub Action](https://developers.openai.com/codex/github-action) · [Terms of Use](https://openai.com/policies/row-terms-of-use/) (403) · [Codex cloud environments](https://developers.openai.com/codex/cloud/environments) · [Device-code setting #9253](https://github.com/openai/codex/issues/9253) · [Sign in with ChatGPT docs hub](https://developers.openai.com/siwc) · [Request a client ID](https://developers.openai.com/siwc/request-client-id) · [Interest form](https://openai.com/form/sign-in-with-chatgpt-interest/) (403) · [Open-source track](https://developers.openai.com/siwc/token-sharing-open-source) · [Open-source sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) · [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) · [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) · [Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) · [DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit) · [Learn: Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) · [Help: using your plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) (403) · [Staff post, 2026-01-09](https://x.com/thsottiaux/status/2009742187484065881) · [Staff post, 16 partners](https://x.com/thsottiaux/status/2105006253986738615) · [The New Stack](https://thenewstack.io/sign-in-with-chatgpt/) · [The Star, 2026-10-04](https://www.thestar.com.my/tech/tech-news/2026/10/04/openai-expands-chatgpt-with-apps-and-third-party-sign-in) · [daily.dev](https://daily.dev/posts/openai-makes-sign-in-with-chatgpt-a-way-to-use-your-subscription-in-third-party-developer-tools-7ewaoo6ze) · [hermes-agent #128880](https://github.com/NousResearch/hermes-agent/issues/128880)

**OpenCode, GitHub, OpenRouter:** [OpenCode providers](https://opencode.ai/docs/providers/) · [GitHub Copilot supports OpenCode](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/) · [OpenRouter terms](https://openrouter.ai/terms)

**Google:** [Gemini CLI terms and privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md) · [Gemini CLI to Antigravity, #27274](https://github.com/google-gemini/gemini-cli/discussions/27274)

**Bootstrap patterns:** [cloud-init formats](https://cloudinit.readthedocs.io/en/latest/explanation/format.html) · [EC2 user data](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html) · [IMDSv2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html) · [Fly OIDC](https://fly.io/docs/security/openid-connect/) · [Fly secrets](https://fly.io/docs/apps/secrets/) · [Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/) · [Kubernetes token projection](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#serviceaccount-token-volume-projection) · [Kubernetes bootstrap tokens](https://kubernetes.io/docs/reference/access-authn-authz/bootstrap-tokens/) · [Kubelet TLS bootstrapping](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/) · [SPIRE concepts](https://spiffe.io/docs/latest/spire-about/spire-concepts/) · [GitHub Actions OIDC](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect) · [Codespaces secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces) · [Dev Containers git credentials](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials) · [Docker Sandboxes credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/) · [Vercel Sandbox credential injection](https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox) · [Cloudflare Sandbox outbound](https://developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/) · [Modal secrets](https://modal.com/docs/guide/secrets) · [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping) · [Vault AppRole](https://developer.hashicorp.com/vault/docs/auth/approle) · [Infisical Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth) · [Infisical Agent Vault](https://github.com/Infisical/agent-vault) · [iron-proxy](https://github.com/ironsh/iron-proxy) · [Tailscale Aperture](https://tailscale.com/docs/aperture/what-is-aperture) · [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) · [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)

**Our own reports:** `research/20261006_agent-linux-desktop.md` · `research/20261006_secrets-vault-core.md` · `research/20261006_push-to-another-instance.md` · `research/20261006_competitive-analysis-2026-10-vision.md` · `research/anthropic-tos-compliance.md` · the 2026-10 vision brief agreed with Dorian (internal working notes)
