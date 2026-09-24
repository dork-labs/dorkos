import { ExternalLink, Flag } from 'lucide-react';
import { reportAbuseHref, useHostLinks } from '../host-links.js';

// Every host link leaves the community for a page the host runs, so it opens in a new tab and
// passes no opener or referrer.
const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** Terms and Privacy under a sign-in or sign-up form; nothing when the host set neither. */
export function HostPolicyLinks() {
  const { termsUrl, privacyUrl } = useHostLinks();
  if (!termsUrl && !privacyUrl) return null;
  return (
    <nav className="row small muted mt-6 gap-4" aria-label="Host policies">
      {termsUrl && (
        <a href={termsUrl} {...external}>
          Terms
        </a>
      )}
      {privacyUrl && (
        <a href={privacyUrl} {...external}>
          Privacy
        </a>
      )}
    </nav>
  );
}

/** The account settings panel with all three host links; nothing when the host set none. */
export function HostLinksPanel({ communityId }: { communityId: string }) {
  const { termsUrl, privacyUrl, reportAbuseUrl } = useHostLinks();
  if (!termsUrl && !privacyUrl && !reportAbuseUrl) return null;
  return (
    <section className="panel" aria-labelledby="host-links-title">
      <h3 id="host-links-title">This host</h3>
      <p className="small muted">The host that runs this community sets these.</p>
      <div className="row flex-wrap gap-2">
        {termsUrl && (
          <a className="button" href={termsUrl} {...external}>
            Terms <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
        {privacyUrl && (
          <a className="button" href={privacyUrl} {...external}>
            Privacy <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
        {reportAbuseUrl && (
          <a className="button" href={reportAbuseHref(reportAbuseUrl, communityId)} {...external}>
            Report a problem <ExternalLink size={14} aria-hidden="true" />
          </a>
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
  if (!reportAbuseUrl) return null;
  return (
    <a
      className="button ghost small mt-1"
      href={reportAbuseHref(reportAbuseUrl, communityId, entryId)}
      {...external}
    >
      <Flag size={14} aria-hidden="true" /> Report
    </a>
  );
}
