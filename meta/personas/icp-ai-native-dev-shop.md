# ICP: AI-Native Dev Shop

**Role**: Ideal Customer Profile (company-level)
**Confidence**: Proto-persona (assumption-based)
**Created**: 2026-02-27
**Reviewed**: 2026-07-06 (positioning review; multi-runtime signal added)
**Review by**: 2027-01-06

---

## Profile

- **Company size**: 1-10 developers
- **Stage**: Bootstrapped or seed-stage
- **Industry**: Software / SaaS / developer tools / consulting

## Characteristics

- Already paying for Claude Pro/Team or API access
- Multiple active repositories (3-15)
- At least one developer running Claude Code daily
- Uses GitHub, has CI/CD, ships weekly or faster
- Comfortable with self-hosted open source tooling
- Values control over convenience — would rather run their own infra than use a managed service
- Uses two or more agent vendors (e.g., Claude Code + Codex) or wants local-model coverage for private repos — the strongest single adoption signal for the multi-runtime cockpit _(added 2026-07-06)_

## Why They Adopt DorkOS

They've hit the ceiling of what isolated agent sessions can do. They want agents to coordinate across their repos, run overnight, and communicate results — without giving up control to a hosted platform.

## Why They Don't Adopt

- If they only use AI agents occasionally (< 5 sessions/week)
- If they prefer managed/hosted solutions over self-hosted
- If they're locked into a competing agent platform with its own orchestration

## Revenue Signals (Future Monetization Context)

- Would pay for a Pro CLI with team features (shared schedules, audit logs)
- Would pay for hosted Relay adapters (managed Slack/Telegram bridges)
- Would NOT pay for the core open source platform itself

_Update 2026-07-06: these hypotheses held up against a full OSS-monetization research pass and are now a designed model: this ICP is the **DorkOS Cloud: Crew** buyer (~$15/seat: shared fleet, shared agents with ACLs, private registries, team spend dashboards, team SSO). See `meta/positioning-202607/11-revenue-model.md`._
