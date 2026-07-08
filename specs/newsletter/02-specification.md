# Newsletter & email capture: specification

Implements ADR 260707-025214. Surface: `apps/site` (Next.js 16, Neon Postgres + Drizzle, Better Auth, Resend, PostHog) plus a `packages/cli` post-install line and README link. RSS-to-email (DOR-198) is a separable follow-up, out of this PR's scope.

## Data model

New table `newsletter_subscriber` (own file `src/db/newsletter-schema.ts`, re-exported from `src/db/schema.ts`; hard-isolated from the telemetry table, no FKs). Columns:

| column                                                           | type                           | notes                                                           |
| ---------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `id`                                                             | text pk                        | random id (`crypto.randomUUID()`)                               |
| `email`                                                          | text unique notnull            | lowercased, trimmed                                             |
| `status`                                                         | text notnull default `pending` | `pending` \| `confirmed` \| `unsubscribed`                      |
| `source`                                                         | text                           | `footer` \| `newsletter-page` \| `blog` \| `unknown`            |
| `confirm_token_hash`                                             | text                           | sha256 of the raw confirm token; nulled on confirm              |
| `confirm_expires_at`                                             | timestamptz                    | 48h TTL                                                         |
| `unsubscribe_token_hash`                                         | text                           | sha256 of the raw unsubscribe token; set on confirm, long-lived |
| `resend_contact_id`                                              | text                           | Resend contact id, set on confirm                               |
| `created_at` / `updated_at` / `confirmed_at` / `unsubscribed_at` | timestamptz                    |                                                                 |

Migration `drizzle/0006_*.sql` generated via `pnpm --filter @dorkos/site db:generate` (updates `meta/` + `_journal.json`; sequential number avoids the ledger-collision gotcha).

## Token design

Raw token = `randomBytes(32).toString('hex')` (Node runtime). Only the **sha256 hash** is stored; the raw token travels in the email URL. Lookup hashes the incoming token and matches. No new secret env needed (the random token is itself the secret). Confirm token expires (48h); unsubscribe token is long-lived. Node runtime on all newsletter routes (crypto + Resend), matching auth.

## API (route handlers, `runtime = 'nodejs'`)

- `POST /api/newsletter/subscribe` — body `{ email, source? }`. Validates email (zod). Upserts a `pending` row (regenerating the confirm token) unless already `confirmed` (no-op). Sends the confirmation email via `lib/mailer.ts` → `sendNewsletterConfirmation`. **Always returns `200 { ok: true }`** regardless of duplicate/existing state (no email enumeration). Send failures are logged, not surfaced.
- `GET /api/newsletter/confirm?token=` — hashes token, finds a non-expired pending row, marks `confirmed`, generates the unsubscribe token, mirrors the address into the Resend Segment (`RESEND_SEGMENT_ID`), then **redirects** to `/newsletter/confirmed`. Invalid/expired → redirect to `/newsletter/confirmed?status=invalid`.
- `GET /api/newsletter/unsubscribe?token=` — hashes token, marks `unsubscribed`, patches the Resend contact to `unsubscribed: true` (suppression, not deletion), redirects to `/newsletter/unsubscribed`.

Resend segment mirror (`lib/newsletter/resend-segment.ts`) is lazy like `mailer.ts`; if `RESEND_SEGMENT_ID` is unset it no-ops with a log (preview/local never touch the network). It uses the modern segments API (Resend deprecated Audiences in its 2025 migration: contacts are account-global, broadcasts target a segment): confirm calls `contacts.create({ email, segments: [{ id }] })` (or reactivates + re-adds an existing contact on re-subscribe); unsubscribe sets the contact's account-wide `unsubscribed` flag. Broadcasts (sent later, DOR-198) carry `List-Unsubscribe` + one-click headers via the unsubscribe URL.

## Capture surfaces (UI)

Reusable `NewsletterSignupForm` (`src/layers/shared/ui/newsletter-signup/`; in the shared layer so the features-layer footer and app pages both consume it without crossing the FSD hierarchy): email input + submit, honeypot field, `pending/success/error` states, cadence microcopy ("Release notes + fleet reports, ~2/month. One click to unsubscribe."), reduced-motion-safe, mobile-first, Calm-Tech styling with existing shadcn `Input`/`Button`. On success it fires the PostHog `newsletter_signup` event **only** through the existing consent-gated client (`posthog.capture`, which respects `opt_out_capturing_by_default`), with **no PII**, only `{ source, email_domain }`.

Placements:

- **Footer** — added to `MarketingFooter` (the footer actually rendered across marketing/story/blog), compact variant.
- **`/newsletter` page** — a dedicated marketing route: hero, the form, the cadence promise, and a link to the `/blog` archive (the archive is the blog itself, per the ADR).
- **End of blog post** — after the MDX body in `(marketing)/blog/[slug]/page.tsx`, above/near the prev-next nav.
- **Result pages** — `/newsletter/confirmed` and `/newsletter/unsubscribed` (simple server components; `confirmed` reads `?status`).

`<Toaster />` (sonner) is mounted in `providers.tsx` (currently absent) for form feedback.

## CLI + README (DOR-197)

- `packages/cli`: a once-only post-install line pointing to `https://dorkos.ai/newsletter` ("Release notes + fleet reports, ~monthly"), printed at most once (guarded by a marker in the dork data dir), suppressible via env (`DORKOS_NO_NEWSLETTER_TIP=1`) and honoring any existing quiet/CI flag. No network calls at install.
- README: a newsletter link/badge near the top.

## Env

Add `RESEND_SEGMENT_ID: z.string().optional()` to `apps/site/src/env.ts` and `.env.example`. No other new secrets. Set it per environment, pointing prod and staging at _different_ segments so test signups never pollute the real list; leave it unset on preview/local (the mirror no-ops).

## Testing

- `newsletter-schema` shape + isolation (no FK to telemetry/account).
- Token hash/generate round-trip.
- Service: subscribe (new/duplicate-pending/already-confirmed/re-subscribe-after-unsubscribe), confirm (valid/expired/invalid), unsubscribe. Resend + mailer mocked via `vi.hoisted` (no network), mirroring `mailer.test.ts`.
- Route handlers: subscribe returns 200 on all valid paths, bad email/JSON → 400 (`subscribe/__tests__/route.test.ts`); confirm redirects to the success page and to `?status=invalid` for a bad token (`confirm/__tests__/route.test.ts`); unsubscribe GET redirects and the RFC 8058 one-click POST returns a bare 200 (`unsubscribe/__tests__/route.test.ts`).
- Form component: renders, submits, fires PostHog capture (mocked), honeypot blocks bots.

## Non-goals (this PR)

Sending broadcasts, RSS-to-email automation (DOR-198), subscriber admin UI, segmentation, the `news.` sending subdomain split.
