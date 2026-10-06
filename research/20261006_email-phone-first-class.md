---
title: 'Email addresses and phone numbers as first-class account features'
date: 2026-10-06
type: internal-architecture
status: active
tags: [email, phone, google-workspace, twilio, 10dlc, provider-adapter, vision-202610]
---

# Email addresses and phone numbers as first-class account features

Research date: 2026-10-06. Web research only; nothing here is decided. Prices are US list prices as found on the date above and change often. Items marked **UNVERIFIED** come from secondary sources only or are my inference.

Framing from the vision notes: people and agents are near-identical accounts; local-only is the default with no required monthly fee; paid cloud is opt-in. Paid cloud details are out of scope here.

---

## TL;DR

1. **Email can be free and first-class.** A free local default exists: a domain the user owns, inbound through Cloudflare Email Routing to a Worker that stores mail until DorkOS pulls it, outbound through a free relay tier (Resend 3,000/month) or the user's own SMTP. "Provisioning an address" is then just a routing rule plus a DorkOS record, with no per-address cost. Without a domain, the zero-setup fallback is the user's existing mailbox via IMAP/SMTP, or Gmail-style plus-addressing, which is weaker.
2. **The founder's Google Workspace idea works technically and is clean to build**: the Admin SDK Directory API creates the user, the License Manager API assigns a seat, and the Gmail API reads and sends as that user through a service account with domain-wide delegation. No public URL is needed: Gmail watch plus a **pull** Pub/Sub subscription works from a laptop. Cost is a full seat (**$7/user/month annual, about $8.40 flexible**, Business Starter). Two real snags: (a) the Workspace AUP forbids accounts "assigned to business functions rather than to human beings **for the purpose of sharing files**", and forbids **reselling** accounts inside a commercial product, so DorkOS can automate the customer's own tenant but DorkOS Cloud cannot resell Workspace seats; (b) new Google Cloud orgs (since May 2024) block service-account key creation by default, so setup needs an org-policy exception or keyless auth. A cheaper in-Workspace variant is one licensed "agents" mailbox with up to 30 aliases (one per agent), with isolation done by DorkOS rather than Google.
3. **Google Voice is a dead end for agents.** There is no official API for calls or SMS. Number assignment is Admin-console only (the Admin SDK has no Voice resource; `developers.google.com/admin-sdk/voice` returns 404). The Voice Acceptable Use Policy explicitly bans "sending messages via an automated process, such as a script" and "Do not automate our system to place phone calls or send messages automatically." Unofficial libraries risk account suspension, which on Workspace could be the founder's company account.
4. **Phones need a paid carrier API.** Twilio ($1.15/month number, $0.0083/SMS segment each way plus carrier fees) or Telnyx ($1.00/month, $0.004/part). US outbound texting from an app is A2P and must be **10DLC-registered** (unregistered traffic has been 100% blocked since Feb 2025). A platform registering for its users is an ISV/CSP; each user who sends texts becomes a Brand (Sole Proprietor: $4 brand, $15 campaign vetting, $2/month, 1 number, 1 msg/sec; the owner's mobile can be used for at most 3 brand registrations). **Calls first** (no registration) is the right order.
5. **VoIP numbers do not reliably receive one-time codes.** Google, banks, Stripe, WhatsApp and others look up line type and refuse `nonFixedVoip`. Twilio and Telnyx numbers are VoIP. An agent that needs to pass SMS verification needs a SIM-backed mobile number, which is a different and murkier supplier category (AgentSIM and similar; **UNVERIFIED** reliability and ToS posture).
6. **Recommendation shape:** an `EmailProvider` and `PhoneProvider` port with the same five verbs (provision, assign, send, receive, release), a free default email path (own domain + Cloudflare inbound + free relay, or IMAP/SMTP), a Google Workspace provider and a Microsoft 365 provider for people who already pay for those, and DorkOS Cloud as the paid "it just works" path (cloud-domain addresses that keep receiving when the laptop is closed, plus carrier-backed numbers with DorkOS doing 10DLC as the ISV).

---

## 1. Google Workspace: a real user per agent

### 1.1 Creating, suspending and deleting users

- **API:** Admin SDK Directory API. `POST /admin/directory/v1/users` creates (`users.insert`); `users.update` with `suspended: true` suspends; `users.delete` deletes; aliases via `users.aliases`. ([Directory API reference](https://developers.google.com/workspace/admin/directory/reference/rest))
- **Scopes:** `https://www.googleapis.com/auth/admin.directory.user` is the "global scope for access to all user and user alias operations"; narrower `...user.alias` exists for alias-only work. ([Choose Directory API scopes](https://developers.google.com/workspace/admin/directory/v1/guides/authorizing))
- **Licence assignment:** Enterprise License Manager API, `POST /apps/licensing/v1/product/{productId}/sku/{skuId}/user`. The customer must already have purchased the seats; the API assigns, it does not buy. ([License Manager API](https://developers.google.com/workspace/admin/licensing/reference/rest), [licenseAssignments](https://developers.google.com/workspace/admin/licensing/reference/rest/v1/licenseAssignments))
- **Auth options:**
  - **Service account + domain-wide delegation (DWD):** an admin authorizes the service account's client ID with specific scopes under Security, API Controls, Domain-wide Delegation. For Directory calls the service account must impersonate an account holding admin privileges. ([Google forum on DWD + Directory](https://discuss.google.dev/t/google-directory-api-service-acount-with-domain-wide-delegation/164589), [Server-to-server OAuth](https://developers.google.com/identity/protocols/oauth2/service-account))
  - **OAuth with an admin user:** an "Internal" OAuth app skips Google verification and only shows consent to org members. Domain-wide installed apps also avoid brand verification. ([Workspace production-readiness notes](https://developers.google.com/identity/protocols/oauth2/production-readiness/google-workspace), [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification))
- **Why "bring your own Google Cloud project" matters for an open-source app:** if DorkOS shipped ONE shared public OAuth client using restricted Gmail scopes (`gmail.readonly`, `gmail.modify`, `mail.google.com`), it would need Google verification plus an annual CASA third-party security assessment, and stay capped at about 100 users until then ([Unipile on OAuth/CASA](https://www.unipile.com/integrating-google-oauth-2-0-user-authentication-into-your-app/), [DeepStrike on CASA](https://deepstrike.io/blog/google-casa-security-assessment-2025); secondary sources). Having each admin create their own project (Internal app or DWD) avoids that. DorkOS Cloud could later get one verified client as a paid convenience.
- **Gotcha:** organizations created on or after 2024-05-03 enforce `iam.disableServiceAccountKeyCreation` by default ([Google Cloud docs](https://docs.cloud.google.com/iam/docs/keys-create-delete), [secure-by-default orgs](https://docs.cloud.google.com/resource-manager/docs/secure-by-default-organizations?hl=en)). A setup wizard must either walk the admin through a scoped exception or use keyless auth (Workload Identity Federation). **UNVERIFIED:** whether WIF is practical from a laptop without a cloud identity to federate from; for a local app, a JSON key under a project-level exception is the realistic path.

### 1.2 Licence cost (2026)

| Plan              | Annual, per user/month | Flexible (monthly) | Storage      |
| ----------------- | ---------------------- | ------------------ | ------------ |
| Business Starter  | $7                     | ~$8.40             | 30 GB pooled |
| Business Standard | $14                    | ~$16.80            | 2 TB         |
| Business Plus     | $22                    | n/a here           | 5 TB         |

Annual prices from [Google Workspace pricing](https://workspace.google.com/pricing) (Google currently shows an intro discount for new customers on the first 20 users for 12 months). Flexible prices from secondary sources ([Lark](https://www.larksuite.com/en_us/blog/google-workspace-pricing), [iTechGuides](https://www.itechguides.com/google-workspace-pricing-how-to-choose-the-right-plan-in-2026/)), **UNVERIFIED** against Google.

### 1.3 Is a "bot" user allowed?

The Workspace Acceptable Use Policy ([Google Workspace AUP](https://workspace.google.com/intl/en/terms/use_policy/)) says customers may not:

- "create End User Accounts assigned to business functions rather than to human beings **for the purpose of sharing files**" within or outside of the domain"
- "grant multiple individuals access to an individual End User Account other than via the delegation features provided within the Services"
- "**resell End User Accounts, or parts thereof, as added into a commercial product offered to third parties**"
- "generate, distribute, publish or facilitate unsolicited mass email"

Reading: the business-function clause is scoped to file sharing (it targets people creating a fake user to dodge Drive sharing limits). A licensed, paid seat whose job is to send and receive mail is not clearly banned, and role mailboxes (support@, billing@) as licensed users are common practice. **UNVERIFIED:** I found no Google statement that explicitly permits or forbids an AI agent as a licensed user. Google's own 2026 agent-identity work (Gemini Enterprise "Agent Identity", announced at Next '26) is an IAM identity, not a Workspace user with a mailbox ([Infosecurity](https://www.infosecurity-magazine.com/news/google-ai-agent-identities-gemini/), [Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/whats-new-in-gemini-enterprise-agent-platform)). Implications:

- **Fine:** DorkOS, run by the customer's admin, automating the customer's own tenant and the customer paying Google for each seat.
- **Not fine:** DorkOS Cloud buying Workspace seats and reselling agent mailboxes on them (the resale clause). Cloud mail must sit on a mail supplier that permits resale.
- **Keep humans out of the agent's account:** the "multiple individuals" clause means humans should watch the agent's mail through DorkOS or Gmail delegation, not by sharing its login. Agents have no password anyway in the DWD model.

### 1.4 Cheaper alternatives inside Workspace

| Option                                 | Cost         | Agent gets                                                                       | Limits                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full user per agent                    | 1 seat each  | Own mailbox, own Drive, own calendar, own send quota                             | $7+/agent/month                                                                                                                                                                                                                                                                                                                                                                 |
| **One "agents" user + aliases**        | 1 seat total | An address per agent (`ada@co.com` alias on `agents@co.com`); send-as each alias | Up to **30 aliases** per user ([Google help](https://support.google.com/a/answer/33327?hl=en), [Directory aliases](https://developers.google.com/workspace/admin/directory/v1/guides/manage-user-aliases)); all agents share one mailbox, one 2,000/day send cap, and one search index; DorkOS must route by `Delivered-To` and enforce that agent A cannot read agent B's mail |
| Alias on the human's own account       | 0            | Address only                                                                     | Agent mail lands in the founder's personal inbox; the agent needs access to that mailbox. Bad isolation. Avoid                                                                                                                                                                                                                                                                  |
| Google Group / collaborative inbox     | 0            | Receives at an address; members can reply as the group                           | **UNVERIFIED but I found no API to read group messages**; the agent would still read via a member's mailbox. Also 30 aliases per group                                                                                                                                                                                                                                          |
| "Send mail as"                         | 0            | Send from another address                                                        | Up to 99 addresses ([Keeping](https://www.keeping.com/content/google-workspace-email-alias/), secondary). Sending only; no inbox, no history                                                                                                                                                                                                                                    |
| Plus-addressing (`founder+ada@co.com`) | 0            | Free, unlimited, instant                                                         | Lands in the human's mailbox; obviously not a separate identity                                                                                                                                                                                                                                                                                                                 |

**Best cheap pattern:** one licensed `agents@` mailbox (or one per team) with an alias per agent, filtered by DorkOS. One seat serves up to 30 agents. Move an agent to its own seat when it needs its own Drive or calendar, or its own send quota.

### 1.5 Gmail API for the agent

- **Read/send as the user:** with DWD the service account impersonates `agent@co.com` and calls `users.messages.send`, `users.history.list`, etc. Scopes: `gmail.send`, `gmail.modify` (restricted). ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes))
- **Sending limits:** 2,000 messages/user/day on paid Workspace (500 on trial), and 500 recipients per message via the API ([Google Workspace sending limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)). Bulk or cold sending from an agent seat is both a quota and an AUP problem.
- **Push vs poll for a laptop with no public URL:** call `users.watch` with a Cloud Pub/Sub topic; Gmail posts change events to the topic. A **pull subscription works without any public endpoint**: the laptop pulls and acknowledges. Watch must be renewed **at least every 7 days** (Google recommends daily), and notifications are capped at **1 event/second per user**, with excess dropped. ([Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)) On wake, DorkOS resumes from the last `historyId` with `history.list`, so a closed lid loses nothing: **Gmail is itself the store-and-forward.**

---

## 2. Google Voice

- **No official API** for placing calls or sending/receiving SMS, personal or Workspace. ([Quo](https://www.quo.com/blog/google-voice-api/), [API Evangelist profile](https://github.com/api-evangelist/google-voice)) The Admin SDK has no Voice resource (the URL `developers.google.com/admin-sdk/voice` returns 404 as of today). Assigning numbers and Voice licences is an Admin console task ([Assign Voice numbers](https://knowledge.workspace.google.com/admin/voice/assign-voice-numbers-to-users), [Assign Voice licences](https://knowledge.workspace.google.com/admin/voice/assign-voice-licenses-to-users)). **UNVERIFIED:** some secondary sources claim Voice provisioning is possible through the Admin SDK; I could not find such an endpoint.
- **Price:** Workspace Voice add-on $10 / $20 / $30 per user per month (Starter capped at 10 users) on top of the Workspace seat ([Google Voice product page](https://workspace.google.com/products/voice/), [Forbes Advisor](https://www.forbes.com/advisor/business/software/google-voice-pricing/)).
- **Terms:** the Voice Acceptable Use Policy forbids "sending messages via an automated process, such as a script" and says "Do not automate our system to place phone calls or send messages automatically." ([Voice AUP](https://support.google.com/voice/answer/9230450?hl=en)) Google "may limit or terminate your access" on violation.
- **Workarounds:** unofficial libraries such as `googlevoice` on PyPI ([PyPI](https://pypi.org/project/googlevoice/)) scrape the web client and break often; browser automation is the same thing with more steps. Both are direct AUP violations, and on Workspace the account at risk is a seat in the founder's company tenant. **Do not build on this.**
- **A side door, not a fix:** Google added "Carrier Link for Google Voice" in June 2026 ([Workspace Updates](https://workspaceupdates.googleblog.com/2026/06/carrier-link-for-google-voice.html?m=1)), and Voice has long had SIP Link for bringing your own carrier. These let a human see carrier numbers in Google Voice; they give an agent no API. **UNVERIFIED** in detail.

**Verdict:** the founder's doubt is right. Give agents carrier-API numbers (Twilio/Telnyx), and optionally forward or bridge them to a human's Google Voice number at the carrier, not inside Google.

---

## 3. Microsoft 365 equivalent

- **Create user:** Graph `POST /users`, least-privileged application permission `User.Create` (or `User.ReadWrite.All`). ([Create user](https://learn.microsoft.com/en-us/graph/api/user-post-users?view=graph-rest-1.0))
- **Assign licence:** `POST /users/{id}/assignLicense`, least privilege `LicenseAssignment.ReadWrite.All`. ([assignLicense](https://learn.microsoft.com/en-us/graph/api/user-assignlicense?view=graph-rest-1.0))
- **Cheapest mailbox options:**
  - **Shared mailbox: no licence needed** (up to 50 GB, no archive), readable and sendable via Graph application permissions. Scope the app to only those mailboxes with **Exchange RBAC for Applications** (Application Access Policies are being retired). ([About shared mailboxes](https://learn.microsoft.com/en-us/microsoft-365/admin/email/about-shared-mailboxes?view=o365-worldwide), [Mindcore on restricting Mail.Send](https://blog.mindcore.dk/2026/02/microsoft-graph-remembered-to-restict-mail-send-application-permission-app-access-policies/), [c7solutions](https://c7solutions.com/2024/09/secure-access-to-mailboxes-via-graph)). This is the M365 counterpart of "free alias" with much better isolation, since each agent has its own mailbox. Strongest cheap option of any suite.
  - Exchange Online Plan 1: $4/user/month (secondary sources, [UrbanIT](https://urbanit.com/insights/exchange-online-plan-1-vs-business-basic/); **UNVERIFIED** against Microsoft).
  - Microsoft 365 Business Basic: $6 rising to $7 from 2026-07-01 ([Ascend](https://blog.teamascend.com/blog/microsoft-365-pricing-updates-start-july-1-2026), secondary).
- **Entra Agent ID "agent's user account" (agentUser):** a user subtype tied 1:1 to a parent agent identity. It gets `idtyp=user` tokens, can be in groups and hold licences, and **cannot have a password or passkey**; it authenticates only through its parent agent identity, cannot hold privileged admin roles, and cannot sign in interactively. Important caveat from Microsoft: "Creating an agent's user account directly through the Microsoft Graph API establishes the identity in Microsoft Entra but **doesn't provision Microsoft 365 capabilities**"; mailboxes and Teams presence come through Teams/Agent 365. ([Microsoft Learn: agent users](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-users), updated 2026-09-30)
- **Agent 365:** GA 2026-05-01 at $15 per user (per sponsoring human, not per agent), with a prerequisite of M365 E5, Business Premium, or similar; also bundled in M365 E7 at $99. ([Microsoft Security blog](https://www.microsoft.com/en-us/security/blog/2026/05/01/microsoft-agent-365-now-generally-available-expands-capabilities-and-integrations/), [SAMexpert](https://samexpert.com/agent-365/)) That is an enterprise path, not one for a founder.
- **Receiving without a public URL:** Graph webhooks need a public HTTPS endpoint; alternatives are Azure Event Hubs delivery or **delta queries** (poll with a delta token). For a laptop, delta polling on wake is the simple answer. ([Graph webhooks](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks), [Voitanos on delta](https://www.voitanos.io/blog/microsoft-graph-webhook-delta-query/)) EWS is being retired from 2026-10-01, so build on Graph only.

**Verdict:** an `m365` provider should default to **shared mailbox per agent + Graph + RBAC for Applications** (free beyond the tenant), with "licensed user" as an option. Treat Entra agentUser as a later upgrade for enterprises already on Agent 365.

---

## 4. Free and self-hosted email

### 4.1 Mail servers (if DorkOS ever embeds or recommends one)

| Server   | Licence                                           | Notes                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mox**  | **MIT**                                           | Go, single binary, all-in-one (SMTP, IMAP, SPF/DKIM/DMARC, MTA-STS, ACME), NLnet-funded. Licence-compatible with an MIT app. ([GitHub](https://github.com/mjl-/mox), [xmox.nl](https://www.xmox.nl/))                                                                         |
| Stalwart | AGPL-3.0 Community + proprietary Enterprise (SEL) | Rust, IMAP/JMAP/SMTP/CalDAV. Multi-tenancy and the AI spam classifier are Enterprise-only. AGPL obligations bite if DorkOS Cloud runs a modified copy as a service. ([stalw.art/open-source](https://stalw.art/open-source/), [compare editions](https://stalw.art/compare/)) |
| Maddy    | GPL-3.0                                           | Composable single daemon ([context7 summary](https://context7.com/foxcpp/maddy))                                                                                                                                                                                              |
| Mailcow  | GPL-3.0                                           | Docker bundle (Postfix, Dovecot, SOGo); heavy for a laptop ([GitHub](https://github.com/mailcow/mailcow-dockerized))                                                                                                                                                          |

Bundling GPL/AGPL software as a separate process is fine for MIT DorkOS; linking it in is not. Mox is the only MIT one.

### 4.2 Deliverability from a home IP

Effectively no-go for outbound. Most residential ISPs block outbound port 25 and do not allow PTR (reverse DNS) records; Spamhaus's Policy Block List lists residential ranges, so receivers reject or junk mail even with SPF/DKIM/DMARC. ([Spamhaus PBL](https://www.spamhaus.org/blocklists/policy-blocklist/), [PBL FAQ](https://www.spamhaus.org/faqs/policy-blocklist-pbl/)) Inbound port 25 to a laptop has the same problems, plus no static IP and NAT. **Conclusion: a laptop should never be an MX or send directly. Outbound always goes through a relay on 587/465; inbound always lands somewhere always-on first.**

### 4.3 Outbound relays with your own domain

| Relay                                                | Free tier                                                                                               | Paid                                                                 | Inbound?                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resend**                                           | 3,000/month, 100/day, 1 domain (received mail counts toward the limits)                                 | Pro $20/month for 50k                                                | Yes ([Automation Atlas](https://automationatlas.io/answers/resend-free-tier-explained-2026/), secondary)                                                                                                             |
| Amazon SES                                           | none to speak of; new accounts default to "Essentials" at $0.16/1k; à la carte $0.10/1k                 |                                                                      | Yes, $0.10/1k + $0.09 per 1k 256 KB chunks ([CampaignHQ](https://blog.campaignhq.co/amazon-ses-pricing-2026/), secondary, **UNVERIFIED** plan names)                                                                 |
| Postmark                                             | 100/month                                                                                               | $15/month for 10k (no inbound on Basic); Pro $16.50 includes inbound | Pro only ([Sequenzy](https://www.sequenzy.com/pricing/postmark), secondary)                                                                                                                                          |
| Cloudflare Email Sending                             | 3,000/month included, **requires Workers Paid ($5/month)**, then $0.35/1k; public beta since 2026-04-16 |                                                                      | Paired with Email Routing ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-16-email-sending-public-beta/), [blog](https://blog.cloudflare.com/email-for-agents/); price from secondary sources) |
| User's own SMTP (Gmail app password, Fastmail, etc.) | free with an account they already have                                                                  |                                                                      | via IMAP                                                                                                                                                                                                             |

### 4.4 Inbound with a laptop that sleeps: store-and-forward

Mail servers retry for days when a destination is down (RFC 5321 suggests a give-up time of at least 4-5 days), but that only helps if something reachable is the MX. Options, all needing no public URL on the laptop:

1. **The mailbox provider is the store** (Gmail, M365, Fastmail, any IMAP host, AgentMail). DorkOS syncs on wake (IMAP IDLE / Gmail history / Graph delta). Zero infrastructure.
2. **Cloudflare Email Routing + an Email Worker** (free tier): MX points at Cloudflare; a Worker receives each message (up to 25 MiB; 200 rules per domain), writes it to R2/KV/D1 or a Queue, and DorkOS pulls on wake through an authenticated fetch. Email Routing has been free "for years" and the Agents SDK now has an `onEmail` hook with per-address routing to agent instances. ([Email Routing limits](https://developers.cloudflare.com/email-routing/limits/), [Cloudflare blog](https://blog.cloudflare.com/email-for-agents/)) Caveat: the user must have a domain on Cloudflare DNS and deploy a Worker. That is a one-click `wrangler deploy` from DorkOS, but it is still a Cloudflare account. **UNVERIFIED:** whether free-plan Worker CPU limits are enough for large attachments (Cloudflare warns of `EXCEEDED_CPU` on free plans).
3. **DorkOS Cloud mail relay** (paid): DorkOS Cloud is the MX for a DorkOS domain and stores mail until the local instance syncs. Same shape as option 2, operated by us.
4. When the laptop is open, DorkOS's existing built-in tunnel can take webhooks live (Resend inbound, Twilio), but **the tunnel is not a store**: a webhook that fails while the lid is closed must be recoverable from the provider's API (Resend and Twilio both let you list received messages afterwards; **UNVERIFIED** retention windows).

---

## 5. Agent-native email providers, and DorkOS Cloud addresses

- **AgentMail:** API-first inboxes for agents. Free: 3 inboxes, 3,000 emails/month, no custom domain. Developer $20/month: 10 inboxes, 10k emails, 10 custom domains. Startup $200/month: 150 inboxes, 150 domains. Webhooks and websockets on every tier (websockets mean no public URL is needed). ([AgentMail pricing](https://www.agentmail.to/pricing)) Good as an optional provider; at $2/inbox at the Developer tier it is a poor _default_ for "every account has an address".
- **Others:** Cloudflare Email Service (above), Nylas (connects to existing Gmail/Outlook mailboxes), Robotomail, AGmail (free inboxes on its own domain), Sendmux. ([AgentMail's comparison, biased](https://www.agentmail.to/blog/best-email-api-for-ai-agents-2026), [Sequenzy list](https://www.sequenzy.com/alternatives/agentmail-alternatives)) **UNVERIFIED** maturity for most of these; several look like 2026 startups.
- **How DorkOS Cloud could offer addresses on its own domain:** run a cloud MX on a dedicated sending domain (or `<handle>@<org>.<domain>` subdomains), store inbound per account, expose it to the local instance through the existing cloud link (pull on wake, push when connected), and send outbound through a relay with per-org DKIM on subdomains so one org's bad behaviour does not burn everyone's reputation. Build on Cloudflare Email Routing + Workers + Email Sending, or SES inbound + outbound, or white-label AgentMail; each permits resale, which Workspace does not. Required cloud-side controls: per-account send caps, new-account warm-up, abuse reporting, and suppression lists, because the shared domain's reputation is the product. **Custom domain** (bring `acme.com`) should be a paid tier: DorkOS shows the DNS records, and the cloud verifies SPF, DKIM and DMARC.

---

## 6. Phone numbers

### 6.1 Prices (US)

| Provider   | Local number / month                   | Toll-free / month | SMS out                                                                        | SMS in      | Voice                                                           | Source                                                                                                                    |
| ---------- | -------------------------------------- | ----------------- | ------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Twilio** | $1.15                                  | $2.15             | $0.0083/segment + carrier fee ($0.0035 AT&T, $0.0045 T-Mobile, $0.005 Verizon) | $0.0083     | ~$0.014/min out, ~$0.0085/min in (**UNVERIFIED**, secondary)    | [Twilio US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us), [Quiq](https://quiq.com/blog/twilio-voice-pricing/) |
| **Telnyx** | $1.00 (volume discounts down to $0.25) | similar           | $0.004/part + carrier fee                                                      | $0.004/part | Voice API $0.002/min + SIP ~$0.005 out / $0.0032 in (secondary) | [Telnyx numbers](https://telnyx.com/pricing/numbers), [Telnyx Voice API](https://telnyx.com/pricing/voice-api)            |
| Plivo      | ~$0.50-0.80                            |                   | $0.0077                                                                        | $0.0077     |                                                                 | [CloudTalk](https://www.cloudtalk.io/blog/plivo-pricing/) (secondary, **UNVERIFIED**)                                     |
| Vonage     | "a few dollars"                        |                   | $0.00809                                                                       | $0.00649    |                                                                 | [Apidog](https://apidog.com/blog/vonage-sms-api-cost/) (secondary, **UNVERIFIED**)                                        |
| Bandwidth  | not found                              |                   | from $0.004                                                                    |             |                                                                 | [buildmvpfast](https://www.buildmvpfast.com/api-costs/sms) (secondary, **UNVERIFIED**)                                    |

All five provision by API (search available numbers, buy, set webhooks, release). Twilio and Telnyx have the best developer surface; Telnyx owns its network and is about half Twilio's per-message price.

### 6.2 Receiving one-time codes

VoIP numbers are routinely refused. Verifiers (Google, banks, Stripe, Amazon, WhatsApp, Microsoft) run a carrier line-type lookup, often via Twilio Lookup, and reject `nonFixedVoip`/`fixedVoip`; some banks accept enrolment, then silently never deliver codes later. ([Twilio's own blog on filtering VoIP before OTP](https://www.twilio.com/en-us/blog/filter-voip-before-otp-verification), [DEV article](https://dev.to/fathin_dosunmu/why-your-ai-agents-phone-number-gets-blocked-and-how-to-fix-it-48k5), [SlyNumber](https://slynumber.com/blog/why-banks-block-voip-numbers)) Twilio/Telnyx numbers will receive ordinary person-to-number texts and many short-code alerts, but **must not be marketed as "use it for any verification."**

SIM-backed options for agents exist: AgentSIM (claims real T-Mobile numbers, ~$0.99 per OTP session), AgentCall, VirtualSMS, mobilerun (cloud phones). ([AgentSIM](https://agentsim.dev/), [HN](https://news.ycombinator.com/item?id=47753589), [AgentCall](https://agentcall.co/)) **UNVERIFIED and high-risk:** reliability, carrier ToS (consumer SIM plans usually ban automated use), and the fact that many "SMS verification" services exist to beat anti-fraud checks. Using one also means DorkOS helps agents create accounts that services deliberately reserve for humans. **Recommendation: no SIM-backed numbers in the first version.** Prefer the honest path: the agent asks its human sponsor to receive and pass on a code (an approval card), or uses email verification.

### 6.3 US A2P 10DLC (texting from a 10-digit number)

- Since 2025-02-01, US carriers **block 100%** of unregistered A2P traffic on 10DLC ([TextBolt](https://textbolt.com/blog/10dlc-compliance/), [Bandwidth FAQ](https://www.bandwidth.com/support/en/articles/12823085-10dlc-faq)). Any agent texting from a Twilio/Telnyx local number is A2P.
- **Twilio fees** ([Twilio 10DLC page](https://www.twilio.com/en-us/phone-numbers/a2p-10dlc)):
  - Sole Proprietor: $4 brand, $15 campaign vetting, $2/month campaign; **1 campaign per brand, 1 number per campaign, 1 msg/sec**; the owner's mobile number gets an OTP and can be used for at most **3** brand registrations. ([Twilio Sole Prop FAQ](https://support.twilio.com/hc/en-us/articles/9550596959643-A2P-10DLC-Sole-Proprietor-Brands-FAQ), [ISV Sole Prop API](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api-sole-prop-new))
  - Low-Volume Standard: $4 brand, $15 vetting, $1.50-10/month, under 6,000 segments/day.
  - Standard: $44 brand (needs EIN), $15 vetting, $1.50-10/month.
- **ISV model:** a platform registers its own primary profile plus a secondary customer profile, brand and campaign per end user, all by API. The platform is the Campaign Service Provider in TCR terms (direct CSP registration is $200 one-time per [ReadySMS](https://readysms.io/blog/10dlc-registration-cost), secondary). **The end user remains the Brand**: their legal name, address and mobile go to TCR. So "every account gets a texting number" really means "every human sponsor completes a short KYC once." Agents cannot be Brands; they text under their sponsor's or org's brand. Approval typically takes under a week.
- **Practical consequence:** an agent texting _its own owner_ (notifications) is still A2P and needs a campaign. Keep notifications on push, Telegram or email; reserve SMS for agents that must reach other people.

### 6.4 Toll-free numbers

Toll-free texting needs Toll-Free Verification. Since 2026-02-17, new submissions need a Business Registration Number for every business type **except sole proprietors**, plus country of registration and entity type. ([Twilio changelog](https://www.twilio.com/en-us/changelog/business-registration-numbers-required-for-toll-free-messaging-p), [Telnyx TFV docs](https://developers.telnyx.com/docs/messaging/toll-free-verification), [SignalWire](https://signalwire.com/blog/toll-free-messaging-changes-2026)) Toll-free is a reasonable alternative to 10DLC for a platform (one verification per number, no TCR brand), and it is free to verify at Twilio (**UNVERIFIED**).

### 6.5 Outside the US

Many countries require a "regulatory bundle" before you can buy a number: end-user identity plus proof of address, sometimes local. Germany needs a commercial-register excerpt and an address inside the number's area code; the UK accepts any valid address for business local numbers; Twilio validates addresses for AU, BR, FR, DE, IE, IT, MX, NL, PL, ES, LU, AT and GB. ([Twilio address FAQ](https://support.twilio.com/hc/en-us/articles/360007534873-Twilio-phone-number-address-validation-FAQ), [Twilio UK bundle](https://www.twilio.com/docs/phone-numbers/regulatory/reading-regulations-for-the-uk-bundle)) A PhoneProvider needs a "requirements" step that collects the right documents per country, and so does the cloud.

### 6.6 Voice-first via SIP and a speech model

- Calls need no 10DLC registration, so they are the easier first feature.
- OpenAI's Realtime API accepts SIP natively (since GA in August 2025): point a Twilio/Telnyx SIP trunk at it and accept the call via webhook. gpt-realtime-mini is roughly $0.016/min; full models run around $0.05/min blended. Twilio ConversationRelay (bring your own LLM over websocket) is $0.07/min; Telnyx's equivalent is about $0.05/min. ([ForaSoft](https://www.forasoft.com/blog/article/openai-realtime-api-webrtc-sip-websockets-integration), [Layer3 Labs](https://www.layer3labs.io/guides/openai-realtime-api-pricing), secondary, **UNVERIFIED** current model names and rates) Self-hosted alternatives: LiveKit Agents or Pipecat with a SIP trunk (not researched in depth here).
- **Law:** per the FCC's 2024-02-08 declaratory ruling, AI-generated voices are "artificial" under the TCPA. Outbound AI calls to consumers need prior express consent, must identify the caller, and must offer opt-out for telemarketing. ([WSGR](https://www.wsgr.com/en/insights/fcc-rules-ai-generated-voices-are-artificial-under-the-tcpa.html), [Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2024/02/fcc-declares-authority-and-intent-to-regulate-ai-generated-calls-under-the-tcpa)) Inbound calls to the agent and outbound calls to its own sponsor are low-risk; cold outbound is not.
- **Lid closed:** a live call needs an always-on answerer. Locally, the carrier can fall back to voicemail (recorded, transcribed, delivered on wake) or forward to the sponsor's phone. Cloud can answer live.

---

## 7. Provider-adapter design

Follows the existing DorkOS pattern (`AgentRuntime`, `ConnectorProvider`, `CommunityAdapter` with conformance suites). Two ports, one shape. Account-centric: an address or number is an asset **owned by an account** (human or agent), not a connector grant.

```ts
/** One provisioned contact point (an address or a number) owned by a DorkOS account. */
interface ContactPoint {
  id: string; // DorkOS id
  kind: 'email' | 'phone';
  value: string; // 'ada@acme.com' | '+14155550100'
  providerId: string; // 'google-workspace' | 'twilio' | ...
  providerRef: string; // provider-side id (Google user id, Twilio SID, alias)
  accountId: string | null; // assigned owner; null = pooled/unassigned
  capabilities: Capability[]; // 'send' | 'receive' | 'voice-in' | 'voice-out' | 'sms-out' | 'sms-in'
  compliance: ComplianceState; // e.g. 10DLC campaign status, toll-free verification, DKIM verified
  status: 'provisioning' | 'active' | 'suspended' | 'releasing' | 'released';
}

interface ContactProvider<Out, In> {
  readonly id: string;
  /** What this provider can do here and what it costs, shown before anything is bought. */
  describe(): Promise<ProviderOffer>; // pricing hints, requirements (domain? KYC? admin consent?)
  /** Check and complete one-time setup: credentials, domain verification, 10DLC brand. */
  preflight(): Promise<PreflightResult>; // returns the steps still owed, never throws on "not set up"
  /** Create or buy the address/number. Idempotent on (requestKey). Destructive-tier: may spend money. */
  provision(req: ProvisionRequest): Promise<ContactPoint>;
  /** Bind to an account; also updates display name / signature / caller ID. */
  assign(pointId: string, accountId: string): Promise<void>;
  send(pointId: string, msg: Out): Promise<SendReceipt>;
  /** Pull everything since a cursor; the provider (or its store) is the store-and-forward. */
  receive(pointId: string, cursor: string | null): Promise<{ items: In[]; cursor: string }>;
  /** Optional live path when DorkOS is reachable (tunnel, websocket, Pub/Sub pull). */
  subscribe?(pointId: string, onEvent: (e: In) => void): Promise<Unsubscribe>;
  suspend(pointId: string): Promise<void>; // reversible: Workspace suspend, stop routing
  /** Give it back: delete the user/alias, release the number. Destructive-tier. */
  release(pointId: string, opts: { exportFirst: boolean }): Promise<void>;
}

type EmailProvider = ContactProvider<OutboundEmail, InboundEmail>;
type PhoneProvider = ContactProvider<OutboundSms | OutboundCall, InboundSms | CallEvent>;
```

Design notes:

- **`receive(cursor)` is mandatory and `subscribe` is optional.** That single rule makes "lid closed" correct for every provider: Gmail `historyId`, Graph delta token, IMAP UID, Cloudflare queue offset, Twilio message list date.
- **`provision` and `release` are destructive-tier capabilities** behind DorkOS's existing approval gate (they spend money or destroy a mailbox). An agent can _request_ an address for itself; the sponsor approves the cost.
- **`compliance` is first-class state**, not a provider detail: the UI needs to show "texting waits on registration (about a week)" or "DKIM not verified yet".
- **Credentials stay server-side** (same rule as connectors/communities). The agent never sees the Google service-account key or Twilio token; it calls `send` through a DorkOS tool, which enforces per-account caps.

Providers:

| Provider                                           | Provision means                                                                        | Receive via                                                | Notes                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `smtp-imap` (generic)                              | user enters an existing mailbox (or plus-address)                                      | IMAP IDLE + UID cursor                                     | Free, works with anything, the zero-setup fallback                 |
| `own-domain` (Cloudflare inbound + relay outbound) | add a routing rule / Worker address; DKIM via relay                                    | pull from Worker store                                     | **Default free path for people with a domain**; per-address cost 0 |
| `google-workspace`                                 | Directory `users.insert` + licence, or alias on a shared agents user                   | Gmail history + Pub/Sub pull                               | BYO Google Cloud project; AUP: no resale                           |
| `microsoft-365`                                    | shared mailbox (free) or licensed user                                                 | Graph delta                                                | RBAC for Applications to scope access                              |
| `agentmail`                                        | API inbox                                                                              | websocket / list                                           | optional paid third party                                          |
| `self-host` (Mox)                                  | create account on the user's VPS                                                       | IMAP                                                       | for the self-hosters; never on a laptop MX                         |
| `dorkos-cloud` (email)                             | address on the cloud domain or a verified custom domain                                | pull through the cloud link                                | paid, always receiving                                             |
| `twilio`, `telnyx` (phone)                         | search + buy number, set webhooks, attach to a 10DLC campaign / toll-free verification | list messages since cursor; webhooks via tunnel when awake | BYO account = user pays the carrier directly, no DorkOS fee        |
| `dorkos-cloud` (phone)                             | cloud buys the number under its ISV account, registers the sponsor as a brand          | cloud store + live answer                                  | paid; DorkOS carries the compliance work                           |

---

## 8. Recommendation

**Default free path (local-only, no monthly fee):**

- Every account gets an _address slot_. With no setup it uses plus-addressing or an IMAP/SMTP mailbox the user already has (honestly labelled "shared with your inbox").
- One guided upgrade: "Use your own domain." DorkOS deploys a Cloudflare Email Routing Worker (free) as the always-on inbox and uses Resend's free tier (or the user's SMTP) for sending. Unlimited addresses at zero marginal cost; mail waits in Cloudflare while the laptop sleeps. **Caveat:** "free" assumes the user owns a domain (~$10/year) and accepts a Cloudflare account.
- **No phone in the free path** beyond "bring your own Twilio/Telnyx account" (pay-as-you-go, about $1/month per number, pay the carrier directly). Calls first; texting only after the sponsor completes 10DLC sole-proprietor registration ($4 + $15 + $2/month at Twilio).

**Google Workspace path (the founder's idea; build it, it is good):**

- Default to **one licensed `agents@` user with an alias per agent** (one seat for up to 30 agents), with DorkOS enforcing per-agent isolation. Offer "give this agent its own Google account" for agents that need their own Drive, calendar or send quota ($7-8.40/month each, paid to Google).
- BYO Google Cloud project, Internal app or DWD, so no Google verification and no CASA. A setup wizard covers the service-account-key org policy.
- Gmail watch + pull Pub/Sub when awake, `history.list` catch-up on wake. No public URL needed.
- Mirror it for Microsoft 365 with free shared mailboxes.
- **No Google Voice.** No API, and the AUP bans automation.

**Paid DorkOS Cloud path (opt-in):**

- Addresses on a DorkOS domain (and verified custom domains on a higher tier) that receive 24/7 and sync to the local app; built on a supplier that allows resale (Cloudflare Email Service, SES, or white-label AgentMail), never on Workspace seats.
- Numbers bought under DorkOS's ISV account, with DorkOS running 10DLC and toll-free registration and the country document bundles for the user, plus a cloud answerer for live calls while the laptop is closed.

**Top risks:**

1. **ToS:** Workspace bans reselling seats (so cloud cannot be built on them), and its "business function accounts" clause is ambiguous for agents (**UNVERIFIED** either way; ask Google or a lawyer before marketing it). Google Voice automation is banned outright. Consumer SIM plans ban automated use.
2. **Deliverability:** a shared cloud domain lives or dies on abuse control. Per-org subdomains, send caps, warm-up and fast suspension are launch requirements. Home-IP sending is a non-starter.
3. **Compliance:** 10DLC KYC per sponsor (agents cannot be brands); TCPA consent for AI voice calls; per-country number documents; CAN-SPAM/GDPR for agent-sent mail. DorkOS Cloud as ISV takes on carrier-violation exposure (T-Mobile's published penalty is up to $10,000 per content violation, secondary source).
4. **Cost surprises:** per-seat suites scale linearly with agents; carrier fees and 10DLC monthly fees add to the sticker prices; restricted Gmail scopes in a shared OAuth app would trigger an annual paid assessment.
5. **OTP expectations:** users will expect an agent's number to pass bank and Google verification. It will not; say so in the product.

**Flagged as unverified:** flexible Workspace prices; whether Google permits AI agents as licensed users; absence of a Google Groups message-read API; Exchange Online Plan 1 and M365 Business Basic prices (secondary); SES plan names; Postmark and Cloudflare Email Sending prices (secondary); Plivo, Vonage and Bandwidth prices; Twilio voice per-minute; OpenAI Realtime per-minute rates; free toll-free verification; SIM-backed agent number services; provider message-retention windows for catch-up on wake; Workload Identity Federation from a laptop.
