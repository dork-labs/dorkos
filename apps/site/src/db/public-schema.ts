/**
 * The **public** half of the apps/site Neon Postgres schema.
 *
 * `drizzle.public.config.ts` points at this file, so exactly the tables reachable
 * from here are what `drizzle-public/` migrates. It owns four tables and they
 * share one property: nothing in here has a foreign key, a join column, or a
 * shared identifier with anything in `control-plane-schema.ts`. That is what
 * makes the two histories separable over one database.
 *
 * - `marketplace_install_events`, `instance_heartbeats` — anonymous, opt-in
 *   product telemetry. No PII by construction; `__tests__/schema.test.ts` pins
 *   the allowed column set and asserts the absence of foreign keys.
 * - `newsletter_subscriber` — the mailing list.
 * - `feedback_submission` — feedback and bug reports from the app and the site.
 *
 * Adding a table here is a decision about which history owns it. If the table
 * belongs to accounts, device link, admin or managed connectors, it goes in
 * `control-plane-schema.ts` instead.
 *
 * @module db/public-schema
 */
export {
  instanceHeartbeats,
  marketplaceInstallEvents,
  type InstanceHeartbeat,
  type MarketplaceInstallEvent,
  type NewInstanceHeartbeat,
  type NewMarketplaceInstallEvent,
} from './telemetry-schema';
export {
  newsletterSubscriber,
  type NewsletterSubscriber,
  type NewNewsletterSubscriber,
  type NewsletterStatus,
  type NewsletterSource,
} from './newsletter-schema';
export {
  feedbackSubmission,
  type FeedbackSubmission,
  type NewFeedbackSubmission,
  type FeedbackKind,
  type FeedbackSurface,
  type FeedbackStatus,
} from './feedback-schema';
