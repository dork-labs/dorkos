---
id: 261006-225605
title: Agents are trusted by default; outsiders and third-party code are not
status: accepted
created: 2026-10-06
spec: null
superseded-by: null
amends:
  [
    260727-181825,
    260725-133220,
    260923-223904,
    260923-223908,
    260923-223909,
    260822-235802,
    260908-170643,
    260924-213416,
    260924-101531,
    260925-050657,
    261004-235818,
    260818-002803,
    260819-022912,
    260923-223910,
  ]
supersedes: [260822-235759, 0033]
---

# 261006-225605. Agents are trusted by default; outsiders and third-party code are not

## Status

Accepted (operator decision, 2026-10-06; Linear DOR-2737 under DOR-2735).

**Supersedes** two ADRs whose whole decision this one reverses:

- [260822-235759](260822-235759-consent-led-default-flipping.md) — full power by default is consent-led and never a migration. The new posture **is** applied by migration, with a one-time notice.
- [0033](0033-default-deny-cross-namespace-with-subject-pattern-acls.md) — default-deny across namespaces. Our agents may message each other by default; access rules stay as an opt-in firewall.

**Amends** (each stays Accepted; the retired clause is named in its own Status section):

| ADR                                                                                                                                                                                                                                                               | Retired clause                                                                                                                                                                                                                 | What still stands                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [260727-181825](260727-181825-user-safe-defaults.md) user-safe defaults                                                                                                                                                                                           | Rule 1's "whether capability is granted" no longer covers capability granted to **our own agents**                                                                                                                             | Rules 1–4 for data leaving the machine, the exposure perimeter, third-party code and outsider-origin turns; rule 2 (losing state never loses a protection) everywhere                                                                                |
| [260725-133220](260725-133220-tier-decides-the-gate-identity-only-caps-it.md) tier decides the gate                                                                                                                                                               | "`destructive` requires a granted approval" for in-circle actions                                                                                                                                                              | The tier stays on every action; the choke points become the audit points; `destructive` still asks for perimeter and third-party-code actions                                                                                                        |
| [260923-223904](260923-223904-one-permission-model-for-agent-actions.md) one permission model                                                                                                                                                                     | The default for everyone resolving through "Unchanged" or an ask-first preset                                                                                                                                                  | Areas, states and per-agent overrides, as opt-in narrowing; the default becomes "Trusted" (every in-circle area Allowed)                                                                                                                             |
| [260923-223908](260923-223908-always-allow-is-a-per-agent-per-action-setting.md) always allow                                                                                                                                                                     | Nothing yet; it becomes rare in practice                                                                                                                                                                                       | The mechanics, for whoever opts into Ask                                                                                                                                                                                                             |
| [260923-223909](260923-223909-login-off-permission-writes-are-labelled-unverified.md) login-off writes                                                                                                                                                            | "Unidentified callers resolve against the defaults only" as a restriction                                                                                                                                                      | Labelling; unidentified actions are recorded in the audit trail, never silently                                                                                                                                                                      |
| [260822-235802](260822-235802-unattended-surfaces-follow-the-operator-level.md), [260908-170643](260908-170643-rooms-are-an-unattended-surface-and-follow-the-operator-level.md) unattended surfaces                                                              | The per-instance unattended confirm dialog, and tying `canInitiate` pre-selection to the retired consent door                                                                                                                  | Unattended surfaces follow the operator's level; the clamp on file- and package-sourced schedules; the banner for outsider-fed bindings                                                                                                              |
| [260924-213416](260924-213416-schedule-settings-join-the-approval-key.md), [260924-101531](260924-101531-timezone-is-part-of-the-approved-schedule.md), [260925-050657](260925-050657-outside-agent-execution-changes-re-ask-followers.md) schedule approval keys | Re-parking a schedule our own agent made or changed                                                                                                                                                                            | The keys, for schedules whose content came from a package, a Shape or a file nobody local wrote                                                                                                                                                      |
| [261004-235818](261004-235818-started-chat-inherits-starter-level-as-ceiling.md) started-chat ceiling                                                                                                                                                             | The `acceptEdits` cap for an `/mcp` caller whose agent token resolves to one of our registered agents, and the full-autonomy consent ritual. `MCP_API_KEY`, per-user keys held by outside clients, and A2A callers stay capped | "Never higher than the starter", which stops an outsider-origin turn from launching a stronger child                                                                                                                                                 |
| [260923-223910](260923-223910-destructive-actions-ask-and-three-areas-are-never-allowed.md) destructive asks and floor areas                                                                                                                                      | The destructive rule for in-circle actions, and the `safety` and `permissions` floors                                                                                                                                          | The `reach` floor whole: `FLOOR_NEVER_ALLOWED` on every write path, the resolver clamp, and `operator.config_patch` escalating by input into `reach` for any perimeter path it touches. Destructive perimeter and third-party-code actions still ask |
| [260818-002803](260818-002803-interaction-prompts-are-fleet-wide-asks.md) Asks answerable only by a person                                                                                                                                                        | "Only a person decides"                                                                                                                                                                                                        | Separation of duties: **the requester never decides its own request**                                                                                                                                                                                |
| [260819-022912](260819-022912-an-asks-detail-is-addressed-not-broadcast.md) an Ask's detail is addressed                                                                                                                                                          | Nothing yet. Once roles exist, an Ask's detail reaches any role holder who may decide it, agents included                                                                                                                      | Addressed delivery; the requester never decides its own request                                                                                                                                                                                      |

**Not touched here.** The loop guards (room cascade guard, turn budgets, relay turn ceiling, envelope budget: 260726-170127, 260823-000217, 260823-000218, 260824-120429, 260717-163436) are accident guards, not trust gates. They stay exactly as they are until DOR-2745 decides their replacement. The agent-only caps on routine output (posts and canvas operations per turn, the reaction budget of [260814-195522](260814-195522-agents-may-react-with-a-rate-bound.md), the notify budget) are not loop guards; this decision retires them as refusals, and DOR-2753 removes them after the audit trail lands. Approval expiry ([260912-190915](260912-190915-an-approval-expires-on-a-sweep-and-the-agent-is-told.md)) stands for the approvals that remain.

## Context

DorkOS grew up asking first. A fresh install that skips onboarding blocks rooms, asks before every edit and command on Claude Code and OpenCode, denies messages between projects, parks every schedule an agent makes, and refuses connector access until a person grants it agent by agent. Even the "Full power" preset still asks for packages, settings, safety, permissions and outside reach, and every destructive action asks.

Most of that friction does not stop the agent it targets. With login off, the shipped default, the server cannot tell the person in the app from an agent running `curl` (`decision-authority.ts` and `permission-enforcement.ts` say so in writing). The gates slow down honest agents and barely slow down a misbehaving one. Meanwhile the product's own direction ("You, Multiplied"; the litepaper's "Autonomous by default") and its own repo (ADR 260919-174348, "machine gates are the only gates") already assume autonomous agents.

About half of the restriction code is something else entirely: it defends against strangers, third-party code and the public internet. That half is worth more, not less, once agents run at full power.

## Decision

**Our own agents are trusted professionals. Full power is the default, and routine work never waits for a yes. The safety net is an audit trail anyone in the space can read, and the levers to act on it. Trust goes to our agents, never to what reaches them.**

1. **In-circle actions just happen.** An action taken by a person in the space, or by one of our agents acting on a person's or another of our agents' instruction, runs without asking: rooms, schedules, agents, messages, settings that are not perimeter, connections the owner already made, installing packages from sources the owner trusts. Destructive in-circle actions run too, and are recorded. Installing is in the circle; the hooks and global plugins a package carries are not (item 5).
2. **The audit trail comes first.** No gate is loosened until the action it guarded is recorded: who acted (a stable account id, never a path or "You"), for whom, from which session and turn, on what, with what outcome. Anyone in the space, person or agent, can read it, and anyone can pause an agent everywhere from what they see.
3. **Who sees what is set by roles.** People and agents get different default roles, both editable. Both read every agent's chats and every agent-to-agent message, except a person's own direct chats with agents. A person's own private chats stay private: their messages with other people and their direct chats with agents. The actions an agent took during a private chat still show in the trail.
4. **Outsiders seed no power.** A turn that starts from outside the circle (a Telegram or Slack sender, an inbound email or other connector event, a webhook, an A2A peer, an external room author) gets no permission seed and runs in a prompting mode. A chat it starts can never be stronger than its starter. Outside-chat allowlists (`dmPolicy`, approver allowlist) stay closed by default.
5. **Third-party code still needs a yes.** Marketplace hooks, global plugins, extensions from sources the owner has not trusted, and schedules that arrive inside a package or Shape keep their consent, clamp and isolation. Code our own agents write locally is in the circle.
6. **The perimeter is Owner-only.** Login, remote access (tunnel and public bind), credentials and provider keys, `/mcp` and A2A exposure, and package sources (the marketplace source lists and `extensions.trustedSources`) are changed only by the Owner. Until roles exist, Owner-only means today's operator-only write policy, unchanged. The `reach` floor keeps every mechanism of 260923-223910 that enforces this, and the exposure guard keeps refusing to go public without login. An agent that read one hostile web page must not be able to turn the machine into a public one.
7. **Irreversible actions in outside accounts just happen, loudly.** Deleting an email or posting in a client's Slack runs without a card. Everyone is notified, an undo window is offered where the service allows one, and the action is recorded.
8. **Approvals, now rare, go to anyone whose role allows it, person or agent, never the one asking.** Until roles exist the decider stays a person; separation of duties holds from day one.
9. **The new posture is applied by migration.** Existing installs move to it once, with a one-time notice that says what changed and how to opt back into asking. Opting out stays one switch away.

### Classification rule for every gate

Every existing gate is sorted into one of five classes before it is changed: **A** trust gate on our own agent (open it), **B** accident or runaway guard (keep; loop guards are DOR-2745's), **C** outsider security (keep), **D** privacy and ownership (keep, reframed by roles), **E** repo hygiene for coding agents (not product). A gate that is half A and half C is split, never removed whole. The worked inventory lives in the programme's trust audit and is carried into each implementing spec.

### Order of work

1. This decision (DOR-2737).
2. The audit trail (DOR-2738): every action recorded, readable by people and agents, and a pause lever.
3. Full-power defaults with the outsider protections pinned by tests that land **before** any default flips (DOR-2739).
4. Later, with roles and equal accounts: person bars become role checks, approvals open to any role holder except the requester, and the permission machinery collapses to roles plus perimeter.

## Consequences

### Positive

- Routine work stops waiting on people. An agent run overnight finishes overnight.
- One honest story: the gates that remain are the ones that actually defend something (strangers, stranger code, the perimeter).
- Review becomes the control. A person or an agent can read what happened and pause, which works whether or not anyone was watching at the time.

### Negative

- A mistake by one of our own agents now lands before anyone sees it. The audit trail makes it visible and the pause lever stops the next one; it does not prevent the first.
- On "this computer", agents run as the person's OS user, so a determined agent can still edit local records. A hash chain makes edits detectable; proving them needs a checkpoint stored where the agent cannot write, which is follow-up work.
- Existing installs change behaviour at upgrade. The one-time notice and the one-switch opt-out are the price of not doing it silently.
- Several older ADRs now describe code that is still on its way out. Each amended ADR names the clause this one retires, and each implementing ticket removes the code it covers, so no rule is left half true.
