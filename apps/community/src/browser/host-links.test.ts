import { describe, expect, it } from 'vitest';
import { reportAbuseHref } from './host-links.js';

const community = '0b6c1a52-7e1f-4d0e-9a53-3c1e2b7f9d10';
const entry = '5f2d7c34-1a9b-4b8e-8c21-6e0a4d3b2f77';

describe('reportAbuseHref', () => {
  it('adds exactly the community and entry IDs to an https report page', () => {
    // Purpose: fails if the link drops an ID, renames the parameters, or adds anything else.
    expect(reportAbuseHref('https://example.com/report', community, entry)).toBe(
      `https://example.com/report?community=${community}&entry=${entry}`
    );
  });

  it("keeps the host's own query byte for byte and never lets it pre-set an entry", () => {
    // Purpose: fails if a host's query is re-encoded or lost, or if a configured `entry` survives
    // a community-level report and misattributes it to some message.
    expect(reportAbuseHref('https://example.com/report?q=a+b%20c&entry=stale#top', community)).toBe(
      `https://example.com/report?q=a+b%20c&community=${community}#top`
    );
  });

  it('puts the IDs in the body of a mailto report and nowhere else', () => {
    // Purpose: fails if a mail report loses the IDs or gains a subject or other field.
    expect(reportAbuseHref('mailto:abuse@example.com', community, entry)).toBe(
      `mailto:abuse@example.com?body=${encodeURIComponent(`Community: ${community}\nMessage: ${entry}`)}`
    );
  });

  it('returns null instead of throwing for anything that is not a safe report address', () => {
    // Purpose: fails if a bad value reaching the page could throw during render or produce a
    // link with a second recipient.
    for (const target of [
      'not a url',
      'http://example.com/report',
      'javascript:alert(1)',
      'mailto:a,b@evil.com',
      'mailto:abuse@example.com?',
      'mailto:%E0%A4%A',
    ])
      expect(reportAbuseHref(target, community, entry), target).toBeNull();
  });
});
