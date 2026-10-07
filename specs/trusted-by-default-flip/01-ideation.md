---
slug: trusted-by-default-flip
number: 261006-232018
created: 2026-10-06
status: ideation
---

# Full-power defaults, with outsider protections pinned by tests

**Slug:** trusted-by-default-flip
**Author:** Claude (IDEATE for Dorian Collier)
**Date:** 2026-10-06
**Linear:** DOR-2739 (programme DOR-2735; decision DOR-2737; audit trail DOR-2738)

---

## 1) Intent

ADR `261006-225605` decides that our own agents are trusted by default and that outsiders and third-party code are not. This ticket turns that decision into the shipped defaults: what a fresh install does, and what an existing install moves to once, with a notice.

The operator fixed the scope (2026-10-06):

1. A "Trusted" default: every in-circle permission area Allowed except Safety limits (kept at Ask until DOR-2745); `reach` stays a floor; destructive in-circle actions run, and the destructive rule stays only for perimeter and third-party-code actions.
2. Files & commands defaults to Full autonomy for sessions a person or one of our agents starts. Outsider origins stay unseeded. The autonomy acknowledgement must not block the default.
3. Our agents can message each other across projects by default; access rules stay opt-in.
4. Schedules our agents make run straight away (recorded, notified, one-click pause). Package, Shape and file schedules keep parking.
5. Connecting an app shares it with every agent at Read and write.
6. Irreversible actions in connected apps just happen: everyone is told, there is a cancel window, and the action is recorded.
7. Extensions our agents write run without a person approving them. Marketplace and untrusted-source copies keep approval.
8. Existing installs move once, by migration, with a one-time notice and a one-click way back to asking (Careful). Onboarding's power door becomes a short statement.
9. Docs rewritten alongside.

Added 2026-10-06: remove the unattended banner and confirm dialog; remove the agent-only posting, canvas, notify and reaction caps (DOR-2753 folded in); agents create agents exactly like people; "access level" (Owner/Admin/Member/Guest) is never called a role.

Out of scope: loop guards (DOR-2745), access levels, collapsing the permission machinery, `canInitiate`.

## 2) Assumptions

- The audit trail (DOR-2738) lands before any PR here that loosens a default. Every new "just happens" path writes an audit event through `services/audit/audit-log.ts`, and the pause lever from DOR-2738 PR5 is the "one-click pause".
- The outsider pin tests (branch `dor-2739-outsider-pins`) land before the flip and stay green through it.
- With login off, the server still cannot tell a person from an agent running `curl`. Nothing here claims otherwise.

## 3) What reading the code changed

1. **Power can be laundered downstream today, and the flip makes it worse.** A turn a Telegram stranger started runs in a prompting mode, but `relay_send` and `post_to_room` are auto-allowed DorkOS tools in that mode. A post into a room starts other agents' room turns at the operator's configured level; nothing caps them at the poster's level. And a bridged stranger's message into a room conversation that already has a row runs at that row's stored level, because the "seed nothing for external authors" rule only applies on insert. With the configured level at Full autonomy for everyone, both become a path from a stranger to a shell. Fix first: **power flows downstream, never up**. Every agent-to-agent hop (room post, DM) runs no looser than the sender's live level, and an external author's turn never runs looser than the runtime's prompting default, whatever the row says. This is PR1, and it only narrows.
2. **Agent DMs cannot simply "seed the configured stop".** The trust audit recommended it; done naively it is exactly the laundering path in (1). They get the configured stop capped by a sender level the server stamps on the envelope.
3. **Area-level Allowed never skips the marketplace install card.** `marketplace-capabilities.ts` treats only an approval or an action-level Allowed as "a person said yes", so an install asks under every preset. Installing from a configured source needs its own change.
4. **Removing the destructive post-rule is smaller than it looks.** Every perimeter and third-party-code destructive action (`marketplace.link`, `shapes.apply`, hook projection, global plugin activation, template agents, workspaces with effects, `connectors.execute_destructive`) has no area, so the tier gate asks on its own. The post-rule only decides eight area-bearing actions.
5. **A wipe must not widen a Careful choice.** Once the fresh default is Trusted, a config wipe that keeps nothing turns a Careful install into a Trusted one. `permissions.preset` and stricter trust stops need carryover (safe-defaults rule 2).

## 4) Recommendation

Five PRs: narrow first (downstream power), then retire the acknowledgement ritual, then remove the agent-only caps and the unattended alarm (operator addition 2026-10-06, folding in DOR-2753), then flip the posture with its migration and notice, then the connected-app changes with the cancel window. Details in `02-specification.md`.
