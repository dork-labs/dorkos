/**
 * @module features/trust-notice
 *
 * The one-time notice that agents now work without asking (spec
 * `trusted-by-default-flip` §5.8). {@link TrustNoticeMoment} is the body the
 * moments rail mounts; {@link isTrustNoticeEligible} is the rule the rail's
 * descriptor reads to decide whether to offer it.
 */
export { TrustNoticeMoment, TRUST_NOTICE_DOCS_URL } from './ui/TrustNoticeMoment';
export type { TrustNoticeMomentProps } from './ui/TrustNoticeMoment';
export { isTrustNoticeEligible } from './model/trust-notice-eligibility';
