# Agent creation, reborn — ideation

Founder-approved 2026-07-20, in full, from the design companion (visual exploration
artifact "Creating an agent should feel like a birth, not a form") plus a
source-verified investigation of the current territory.

## The problem

Seven entry points funnel into three inconsistent creation experiences:

1. **The wizard dialog** — a mechanism-named three-way fork ("Start Blank / From
   Template / Import Project") that assumes the user already understands DorkOS.
2. **Onboarding's bespoke form** (`NoAgentsFound`) — different fields, no live
   validation, a "Persona" field that secretly writes `description`.
3. **Marketplace agent-package install** — no form at all.

The sharpest failure: the Shapes arrival offer ("Set up Linear Keeper") carries the
agent's full template — displayName, runtime, persona, capabilities, skills — and
throws all of it away by calling `open()` with zero arguments, landing the founder
on the generic fork. Even a wired dialog could not honor it: the create API has no
persona/capabilities/skills fields, hardcodes `capabilities: []`, and the dialog
never sends `runtime`. Separately (test-proven): shape schedules created
global/disabled are never re-bound once the matching agent appears.

## The direction (approved)

Google Drive's template gallery, decomposed: choices named by outcome, the job
visible before commitment, blank as one card among many, context skipping the menu
entirely, import treated as a different job. Plus the emotional arc: creation is a
birth — the peak is the naming, the payoff is the hello, where the agent speaks
first and proves it is alive by offering to work.

Full mockups and rationale live in the companion artifact; the binding contract is
`02-specification.md`.
