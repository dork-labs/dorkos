# Newsletter & email capture: ideation

The decision work is done in **ADR 260707-025214** (accepted): use **Resend Broadcasts + Audiences** for the launch newsletter, not Buttondown, on economics (Resend free tier = 1,000 marketing contacts, reuses the Resend stack already wired for transactional auth email). This spec is the SPECIFY-stage artifact; the ideation is the ADR plus `meta/positioning-202607/09-gtm-plan.md` §3.2.

## Problem

DorkOS has zero owned audience. The launch plan (`meta/positioning-202607/_tracker.md`) needs an email list as the one platform-proof channel, captured from day one, before the Show HN ladder. Today there is no capture surface anywhere on the site.

## Why now

The list compounds only from its start date, and launch messaging (Newsletter #0/#1, Fleet Reports) depends on it existing. It is a Phase-0 instrumentation item.

## Constraints (from the ADR)

- Reuse the existing Resend integration in `apps/site` (`lib/mailer.ts`); no new email vendor.
- Double opt-in (protects deliverability; the auth sending domain is shared until paid-tier subdomain split).
- Honest, no dark patterns: clear cadence promise (~2/month), one-click unsubscribe, consent-gated analytics.
- Privacy: no PII in analytics events (mirror the install-telemetry contract).
