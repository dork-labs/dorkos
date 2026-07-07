/**
 * @module shared/ui/newsletter-signup
 *
 * Newsletter capture form (ADR 260707-025214). A reusable leaf component in the
 * shared layer so every consumer — the marketing footer (feature), the
 * `/newsletter` page and end-of-blog CTA (app) — can render it without crossing
 * the FSD hierarchy. Composes shared UI (Input/Button) + the subscribe API.
 */
export { NewsletterSignupForm, type NewsletterVariant } from './NewsletterSignupForm';
