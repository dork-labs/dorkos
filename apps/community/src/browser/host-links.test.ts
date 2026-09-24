import { describe, expect, it } from 'vitest';
import { reportAbuseHref } from './host-links.js';

const community = '0b6c1a52-7e1f-4d0e-9a53-3c1e2b7f9d10';
const entry = '5f2d7c34-1a9b-4b8e-8c21-6e0a4d3b2f77';

describe('reportAbuseHref', () => {
  it('adds exactly the community and entry IDs to an https report page', () => {
    // Purpose: fails if the link drops an ID, renames the parameters, or adds anything else.
    const href = new URL(reportAbuseHref('https://example.com/report', community, entry));
    expect(`${href.origin}${href.pathname}`).toBe('https://example.com/report');
    expect([...href.searchParams.entries()]).toEqual([
      ['community', community],
      ['entry', entry],
    ]);
  });

  it("keeps the host's own query and never lets it pre-set an entry", () => {
    // Purpose: fails if a host's `?form=` is lost, or if a configured `entry` survives a
    // community-level report and misattributes it to some message.
    const href = new URL(
      reportAbuseHref('https://example.com/report?form=abuse&entry=stale', community)
    );
    expect([...href.searchParams.entries()]).toEqual([
      ['form', 'abuse'],
      ['community', community],
    ]);
  });

  it('puts the IDs in the body of a mailto report and nowhere else', () => {
    // Purpose: fails if a mail report loses the IDs or gains a subject or other field.
    const href = reportAbuseHref('mailto:abuse@example.com', community, entry);
    expect(href).toBe(
      `mailto:abuse@example.com?body=${encodeURIComponent(`Community: ${community}\nMessage: ${entry}`)}`
    );
  });
});
