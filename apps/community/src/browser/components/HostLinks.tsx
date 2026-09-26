import type { ReactNode } from 'react';
import { ExternalLink, Flag } from 'lucide-react';
import { reportAbuseHref, useHostLinks } from '../host-links.js';

const NEW_TAB = '(opens in a new tab)';

/**
 * A link to a page the host runs. An `https:` page opens in a new tab with no opener or
 * referrer, and says so to screen readers; a `mailto:` address hands off to the mail app in
 * place, so it neither opens a tab nor claims to.
 */
function HostLink({
  href,
  className,
  label,
  children,
}: {
  href: string;
  className?: string;
  /** Replaces the visible text as the accessible name, before the new-tab note. */
  label?: string;
  children: ReactNode;
}) {
  const mail = href.startsWith('mailto:');
  const tab = mail ? {} : ({ target: '_blank', rel: 'noopener noreferrer' } as const);
  return (
    <a
      className={className}
      href={href}
      aria-label={label ? (mail ? label : `${label} ${NEW_TAB}`) : undefined}
      {...tab}
    >
      {children}
      {!label && !mail && <span className="sr-only"> {NEW_TAB}</span>}
    </a>
  );
}

/** Terms and Privacy under a sign-in or sign-up form; nothing when the host set neither. */
export function HostPolicyLinks() {
  const { termsUrl, privacyUrl } = useHostLinks();
  if (!termsUrl && !privacyUrl) return null;
  return (
    <nav className="row small muted mt-6 gap-4" aria-label="Host policies">
      {termsUrl && <HostLink href={termsUrl}>Terms</HostLink>}
      {privacyUrl && <HostLink href={privacyUrl}>Privacy</HostLink>}
    </nav>
  );
}

/** The account settings panel with all three host links; nothing when the host set none. */
export function HostLinksPanel({ communityId }: { communityId: string }) {
  const { termsUrl, privacyUrl, reportAbuseUrl } = useHostLinks();
  const report = reportAbuseUrl ? reportAbuseHref(reportAbuseUrl, communityId) : null;
  if (!termsUrl && !privacyUrl && !report) return null;
  return (
    <section className="panel" aria-labelledby="host-links-title">
      <h3 id="host-links-title">This host</h3>
      <p className="small muted">The host that runs this community sets these.</p>
      <div className="row flex-wrap gap-2">
        {termsUrl && (
          <HostLink className="button" href={termsUrl}>
            Terms <ExternalLink size={14} aria-hidden="true" />
          </HostLink>
        )}
        {privacyUrl && (
          <HostLink className="button" href={privacyUrl}>
            Privacy <ExternalLink size={14} aria-hidden="true" />
          </HostLink>
        )}
        {report && (
          <HostLink className="button" href={report}>
            Report a problem <ExternalLink size={14} aria-hidden="true" />
          </HostLink>
        )}
      </div>
    </section>
  );
}

/** A message's Report action; nothing when the host set no report address. */
export function ReportEntryLink({
  communityId,
  entryId,
}: {
  communityId: string;
  entryId: string;
}) {
  const { reportAbuseUrl } = useHostLinks();
  const report = reportAbuseUrl ? reportAbuseHref(reportAbuseUrl, communityId, entryId) : null;
  if (!report) return null;
  return (
    <HostLink className="button ghost small mt-1" href={report} label="Report this message">
      <Flag size={14} aria-hidden="true" /> Report
    </HostLink>
  );
}
