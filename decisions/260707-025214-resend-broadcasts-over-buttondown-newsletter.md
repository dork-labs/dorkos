---
id: 260707-025214
title: Resend Broadcasts over Buttondown for the launch newsletter
status: accepted
created: 2026-07-06
spec: null
superseded-by: null
---

# 260707-025214. Resend Broadcasts over Buttondown for the launch newsletter

## Status

Accepted

## Context

The GTM plan (`meta/positioning-202607/09-gtm-plan.md` §3.2) and the tracker specced **Buttondown** as the newsletter provider. Since that plan was written, two facts changed the calculus: we shipped Resend for transactional auth email (verification + password reset, `apps/site/src/lib/mailer.ts`, cloud-only) against a verified domain, and Resend now ships Broadcasts + Audiences for marketing email. At pre-launch scale with growth targets of 150 → 400 → 1,500 subscribers at ~2 sends/month, the deciding factors are provider economics and integration cost, not features: Resend's free tier covers 1,000 marketing contacts with Broadcasts included, whereas Buttondown's free tier caps at 100 subscribers and charges a $9/mo add-on for RSS-to-email.

## Decision

We will use **Resend Broadcasts + Audiences** for the launch newsletter, keeping Resend as the single email vendor, and retire the Buttondown plan. The two capabilities Resend does not do turnkey are filled in-house at near-zero cost: a **DorkOS scheduled Task** drafts a broadcast from the blog RSS feed (`/blog/feed.xml`) for founder approval (dogfooding the product), and **double opt-in** reuses the existing Better Auth token + `mailer.ts` pattern. Marketing email stays on our verified domain at this scale; we move it to a `news.` subdomain only when volume pushes us onto a paid Resend tier (which lifts the free tier's 1-domain limit anyway). Transactional auth email and marketing email remain the same vendor but logically separate senders.

## Consequences

### Positive

- Zero new vendor, DNS, or billing relationship: one email stack to operate, secure, and reason about.
- Free through ~1,000 contacts, which clears the Month-2 target of 400; Buttondown would bill from subscriber 101.
- RSS-to-email as a scheduled DorkOS Task dogfoods our own scheduling product and seeds Fleet Report content.
- The blog already serves as the public archive, so no hosted-archive feature is needed.

### Negative

- RSS-to-email and double opt-in are build-it-yourself, not turnkey: a small one-time engineering cost Buttondown would have absorbed.
- Resend's free tier is 1 domain, so marketing and transactional auth share a sending identity until we move to a paid tier. This carries a minor deliverability-reputation coupling risk, acceptable at <1,000 low-frequency sends to a double-opt-in developer audience, and revisited with a `news.` subdomain at scale.
- At 1,000+ contacts, Resend marketing Pro is ~$40/mo, a steeper curve than Buttondown's per-subscriber pricing in that band. Revisit this decision if the list outgrows the free tier faster than the revenue arc expects.

## Implementation notes

- **Segments, not Audiences.** Resend's 2025 migration deprecated Audiences in favour of **Segments** (contacts are account-global; broadcasts target a segment; the CLI/dashboard have dropped Audiences). The mirror (`apps/site/src/lib/newsletter/resend-segment.ts`) uses the modern segments API: confirm calls `contacts.create({ email, segments: [{ id }] })`, unsubscribe sets the account-wide `unsubscribed` flag. The env var is `RESEND_SEGMENT_ID` (the "DorkOS Newsletter" segment). Set it per environment; point prod and staging at _different_ segments so test signups never pollute the real list, and leave it unset on preview/local (the mirror no-ops).
- **Topics** (per-category subscription preferences) are deferred until a second email stream ships; with a single newsletter, the account-wide unsubscribe is equivalent. Adopt Topics + topic-scoped unsubscribe when DorkOS sends more than one kind of email.
