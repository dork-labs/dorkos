'use client';

/**
 * dorkos.ai site analytics — every PostHog event name and every `posthog.*`
 * call lives here, so no other file imports `posthog-js` directly. This is
 * the "one place" for event names the GTM plan calls for
 * (meta/positioning-202607/09-gtm-plan.md Part 3.1, DOR-268).
 *
 * ## Env-gating and the consent gate
 *
 * Every export below is a safe no-op when `NEXT_PUBLIC_POSTHOG_KEY` is unset
 * (see instrumentation-client.ts, which skips `posthog.init()` entirely in
 * that case). Calling a `posthog-js` method before `init()` logs a console
 * error, so `analyticsEnabled` guards every call — this is what keeps an
 * unconfigured deploy at zero network requests *and* zero console noise.
 *
 * ## The hybrid consent model (ADR 260713-143958, Phase 0)
 *
 * There is no longer a "capture nothing" state. The SDK runs
 * `cookieless_mode: 'on_reject'`, so **every visitor produces analytics** — the
 * only question is which kind:
 *   - **cookieless** (the default floor): a daily-salted server-side hash, no
 *     cookies, no cross-day identity. Genuinely anonymous.
 *   - **cookies**: normal cookie-based capture, after an opt-in.
 *
 * Region picks the UX (see src/lib/consent.ts and proxy.ts): EU/EEA/UK/CH (and
 * any unknown country, which fails closed) see the opt-in banner; everywhere
 * else analytics is on by default with a one-click off switch on /privacy.
 * `CookieConsentBanner` reconciles the actual capture state on mount and honors
 * DNT + Global Privacy Control as decline signals.
 *
 * To turn analytics on for a deploy, set `NEXT_PUBLIC_POSTHOG_KEY` (and
 * `NEXT_PUBLIC_POSTHOG_HOST` for EU) — and enable cookieless mode in the
 * PostHog *project* settings, or cookieless events are dropped server-side.
 * `siteConfig.disableCookieBanner` is a kill switch for the banner UX only.
 * Before changing the model, honor the /privacy and /cookies pages' promise:
 * update their wording and "Last updated" dates in the same PR.
 *
 * ## The launch funnel (Part 3.1)
 *
 * | Event                | Fires when                                          |
 * | --------------------- | --------------------------------------------------- |
 * | `$pageview` (default) | Every page load and client-side route change (see `capture_pageview: 'history_change'` in instrumentation-client.ts) |
 * | `hero_install_copy`   | Visitor copies the install one-liner in the hero terminal |
 * | `hero_download`       | Visitor clicks a desktop-download link — macOS (install hero, nav, or the off-Mac terminal-hero link) or Windows (install hero, nav, or the "Other ways to install" link) |
 * | `docs_visit`          | Visitor lands on a `/docs` page                      |
 * | `marketplace_browse`  | Visitor lands on `/marketplace`                      |
 * | `github_click`        | Visitor clicks an outbound GitHub link (header, footer, or mobile hero CTA) |
 * | `newsletter_signup`   | Visitor completes the newsletter signup form         |
 *
 * The GTM plan's own draft names three of these slightly differently
 * (`install_copy_click`, `docs_entered`, `marketplace_pkg_view` — the last is
 * actually a different, more granular event: a single package's detail page,
 * not the catalog). `newsletter_signup` was already shipped (the newsletter
 * form fires it today) and is kept as-is rather than renamed to
 * `newsletter_submit`, so no analytics history forks under two names. Use the
 * names in the table above — they are what the code actually fires — when
 * building the funnel.
 *
 * ## Building the funnel in PostHog
 *
 * In the PostHog UI: Product analytics -> Insights -> New insight -> Funnel.
 * Add steps by event name from the table above, e.g.:
 *   - "The KPI" funnel: `$pageview` -> `hero_install_copy`
 *   - "Newsletter" funnel: `$pageview` -> `newsletter_signup`
 *   - "Docs-to-install" funnel: `docs_visit` -> `hero_install_copy`
 * Break down any step by the `utm_source`/`utm_medium`/`utm_campaign` person
 * properties (see below) to see which launch-ladder rung drove it.
 *
 * ## UTM discipline
 *
 * PostHog's JS SDK captures campaign params (`utm_source`, `utm_medium`,
 * `utm_campaign`, `utm_term`, `utm_content`, plus `gclid`/referrer) itself on
 * init — no code here does this. It reads them from the *landing* URL once
 * per session/person and stores them as `$initial_utm_*` person properties,
 * which are then attached to every event for that visitor automatically,
 * including `$pageview`s fired later by client-side navigation
 * (`capture_pageview: 'history_change'`). So a visitor who lands on
 * `/blog/some-post?utm_source=hn` and *then* clicks through to `/docs` still
 * carries `utm_source=hn` on the resulting `docs_visit` event — first-touch
 * survives client-side navigation with zero extra code. Verified against the
 * installed `posthog-js` SDK (`PostHogPersistence.update_campaign_params`).
 * The one thing this file adds is `utm_source`/`utm_medium` tags on the
 * site's own outbound GitHub links (see `trackGithubClick` below) — that is
 * link hygiene for our own referral traffic, a different mechanism from the
 * inbound first-touch capture described here.
 *
 * @module lib/analytics
 */
import posthog from 'posthog-js';
import { env } from '@/env';

/** True once a PostHog project key is configured; every helper below no-ops otherwise. */
const analyticsEnabled = Boolean(env.NEXT_PUBLIC_POSTHOG_KEY);

/** Fire a named event. No-ops (no call, no console noise) when analytics is disabled. */
function capture(event: string, properties?: Record<string, unknown>): void {
  if (!analyticsEnabled) return;
  posthog.capture(event, properties);
}

// ─── Launch funnel events (Part 3.1) ───────────────────────────────────────

/** Which install method the visitor copied from the hero terminal. */
export type InstallMethod = 'curl' | 'npm';

/** Fires when a visitor copies the install one-liner in the hero terminal. */
export function trackHeroInstallCopy(method: InstallMethod): void {
  capture('hero_install_copy', { method });
}

/**
 * Where a desktop-download link was clicked. The `windows_*` placements
 * mirror their macOS counterparts (`hero`, `install_page`);
 * `windows_other_ways` is the Windows link inside the "Other ways to
 * install" disclosure shown to non-Windows visitors. The former `nav` /
 * `windows_nav` placements retired when the header CTA became a "Get
 * started" link to `/install` (see {@link trackGetStartedNav}).
 */
export type DownloadPlacement =
  | 'hero'
  | 'terminal_hero_link'
  | 'install_page'
  | 'windows_hero'
  | 'windows_install_page'
  | 'windows_other_ways';

/** Fires when a visitor clicks a desktop-download link (`/download/mac` or `/download/windows`). */
export function trackHeroDownload(placement: DownloadPlacement): void {
  capture('hero_download', { placement });
}

/** Fires when a visitor clicks the header "Get started" CTA (links to `/install`). */
export function trackGetStartedNav(): void {
  capture('get_started_nav');
}

/** Fires when a visitor lands on a `/docs` page. */
export function trackDocsVisit(path: string): void {
  capture('docs_visit', { path });
}

/** Active filters on the marketplace catalog at the moment of the visit. */
export interface MarketplaceBrowseFilters {
  type?: string;
  category?: string;
  q?: string;
}

/** Fires when a visitor lands on the `/marketplace` catalog page. */
export function trackMarketplaceBrowse(filters: MarketplaceBrowseFilters): void {
  capture('marketplace_browse', { ...filters });
}

/** Where on the site an outbound GitHub link was clicked. */
export type GithubClickPlacement = 'header' | 'footer' | 'hero_mobile';

/** Fires when a visitor clicks an outbound GitHub link. */
export function trackGithubClick(placement: GithubClickPlacement): void {
  capture('github_click', { placement });
}

/** Fires when a visitor completes the newsletter signup form. No PII: only the capture source and email domain. */
export function trackNewsletterSignup(source: string, emailDomain: string): void {
  capture('newsletter_signup', { source, email_domain: emailDomain });
}

// ─── Other site events (error tracking, consent) ───────────────────────────
// Not part of the launch funnel, but centralized here for the same reason:
// one place for event names, and one place that already knows how to no-op
// safely when no key is configured.

/** Fires when a route-level error boundary catches an unhandled error. */
export function trackClientError(
  error: Error & { digest?: string },
  scope: 'route' | 'global'
): void {
  if (!analyticsEnabled) return;
  posthog.captureException(error);
  capture(scope === 'global' ? 'global_error' : 'client_error', {
    error_message: error.message,
    error_digest: error.digest,
  });
}

/** Fires when a visitor reveals the plain-text contact email (IdentityClose). */
export function trackContactEmailRevealed(): void {
  capture('contact_email_revealed');
}

/** Whether PostHog currently has capture opted out. Defaults to `true` (opted out) when disabled. */
export function hasOptedOutCapturing(): boolean {
  if (!analyticsEnabled) return true;
  return posthog.has_opted_out_capturing();
}

/**
 * Fired on `window` whenever the visitor's capture state flips (opt in/out), so
 * decoupled listeners — e.g. the account-identity bridge in
 * `src/layers/widgets/analytics-identity` — can re-evaluate identity without
 * importing the banner or reaching into PostHog's internals. The banner
 * reconcile, the /privacy toggle, and an explicit accept all flip capture state
 * through {@link optInCapturing} / {@link optOutCapturing}, so dispatching here
 * covers every path.
 */
export const CONSENT_CHANGED_EVENT = 'dorkos:consent-changed';

/** Notify {@link CONSENT_CHANGED_EVENT} listeners that capture state changed. */
function notifyConsentChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}

/** Opt into capturing. Mirrors `posthog.opt_in_capturing`; no-ops when disabled. */
export function optInCapturing(options?: { captureEventName?: string | false }): void {
  if (!analyticsEnabled) return;
  posthog.opt_in_capturing(options);
  notifyConsentChanged();
}

/** Opt out of capturing. Mirrors `posthog.opt_out_capturing`; no-ops when disabled. */
export function optOutCapturing(): void {
  if (!analyticsEnabled) return;
  posthog.opt_out_capturing();
  notifyConsentChanged();
}

// ─── Identified analytics (ADR 260713-143958 Phase 4, Tier 2 — opt-in) ─────────
// A signed-in visitor who has *opted in* (cookies mode) is identified by their
// Better Auth account UUID — a random, pseudonymous id, never their email or
// name. Everything else on the site stays anonymous/cookieless. See the module
// doc above and src/layers/widgets/analytics-identity for the login/logout wiring.

/**
 * Identify the current visitor as a DorkOS account, keyed by the account's
 * Better Auth UUID (a random, pseudonymous id — **never** email/name/username).
 *
 * Gated on consent: this no-ops unless analytics is enabled **and** the visitor
 * is opted in (cookies mode). Under the site's `cookieless_mode: 'on_reject'`,
 * `has_opted_out_capturing()` is `true` for every undecided, declined, DNT/GPC,
 * or cookieless-floor visitor, so the guard means an anonymous-floor visitor can
 * never gain a person profile — the Tier 2 opt-in invariant.
 *
 * Verified against posthog-js 1.395.0: `identify()` itself does not check
 * opt-out (it only refuses when `person_profiles: 'never'`); it calls
 * `capture('$identify', { $anon_distinct_id })`, which merges the prior
 * anonymous browser history into the identified person. We therefore gate here
 * rather than rely on the SDK — belt (this guard) and suspenders (cookieless
 * events carry no person profile server-side). The single `$set: { is_account:
 * true }` flag is the only person property set; no PII is ever attached.
 *
 * Idempotent: PostHog dedupes a repeat identify with the same distinct id.
 *
 * @param accountId - The Better Auth account UUID to use as the distinct id.
 */
export function identifyAccount(accountId: string): void {
  if (!analyticsEnabled) return;
  if (posthog.has_opted_out_capturing()) return;
  posthog.identify(accountId, { $set: { is_account: true } });
}

/**
 * Reset PostHog identity — call on logout, religiously, so a shared browser
 * never bleeds one account's identified events into the next visitor. Generates
 * a fresh anonymous distinct id and clears the identified person link. No-ops
 * when analytics is disabled.
 *
 * Only call this on a genuine login→logout transition, never on every render:
 * `reset()` mints a new anonymous id each call, which would fragment anonymous
 * analytics if spammed (see the analytics-identity bridge's transition guard).
 */
export function resetIdentity(): void {
  if (!analyticsEnabled) return;
  posthog.reset();
}

/**
 * The visitor's current PostHog distinct id, or `null` when analytics is
 * unconfigured. Used by the feedback form to tag a submission with a
 * pseudonymous id so it can be correlated with the same visitor's page views;
 * the caller falls back to a random UUID when this is `null`. No PII either way.
 */
export function getAnalyticsDistinctId(): string | null {
  if (!analyticsEnabled) return null;
  return posthog.get_distinct_id();
}
