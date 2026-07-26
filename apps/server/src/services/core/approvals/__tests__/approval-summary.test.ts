/**
 * Tests for the two functions that render caller-supplied text onto an approval
 * card (spec `agent-trust` §3.3).
 *
 * TWO independent defects are pinned here, and each is separately load-bearing:
 *
 * 1. **Both functions clamped BEFORE redacting.** Clamping slices a 32-hex run
 *    below 32 characters, so the secret pattern stopped matching and a padded
 *    token published its surviving prefix. The storage-level sweep could not
 *    recover it, because by then the run was already short.
 * 2. **The pattern was `\b`-anchored.** `\b` requires a non-word character before
 *    the run, so a token glued to other word characters never matched AT ALL —
 *    at any point in the pipeline, in either order. Reordering alone does not fix
 *    a padded token; dropping the anchors alone does not fix a clamped one.
 *
 * What escapes is `approvals.summary`, which rides the global event stream and the
 * agent-readable `GET /api/approvals/pending`.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  quoteSummaryValue,
  renderRequesterLabel,
  REDACTED_SUMMARY_VALUE,
} from '../approval-summary.js';

/** A live-looking token: 128 bits of hex, the shape of every token DorkOS mints. */
const TOKEN = 'f3a9c1d47b8e5026aa11bb22cc33dd44';

/** Any run this long from the token counts as a partial publication. */
const PREFIX = TOKEN.slice(0, 12);

describe('quoteSummaryValue', () => {
  it('quotes and escapes so an injected separator cannot become a second field', () => {
    expect(quoteSummaryValue('pkg, purge: no')).toBe('"pkg, purge: no"');
    expect(quoteSummaryValue('a\nb')).toBe('"a\\nb"');
  });

  it('hides a token-shaped value', () => {
    expect(quoteSummaryValue(TOKEN)).toBe(`"${REDACTED_SUMMARY_VALUE}"`);
  });

  it('hides a token PADDED past the length cap, not just a bare one', () => {
    // 56 + 32 = 88 characters, over the 80-char value cap. Clamping first left the
    // token sliced to 23 hex characters, below the pattern's 32-character floor.
    const padded = `${'x'.repeat(56)}${TOKEN}`;

    const rendered = quoteSummaryValue(padded);

    expect(rendered).not.toContain(PREFIX);
    expect(rendered).toContain(REDACTED_SUMMARY_VALUE);
  });

  it('hides a token GLUED to other word characters, which no boundary precedes', () => {
    // Short enough that no clamping happens: this one is purely about the pattern
    // having been `\b`-anchored, which a caller evades with a single letter.
    const rendered = quoteSummaryValue(`pkg${TOKEN}`);

    expect(rendered).not.toContain(PREFIX);
    expect(rendered).toBe(`"pkg${REDACTED_SUMMARY_VALUE}"`);
  });

  it('hides a token that is separated by a space but sliced by the cap', () => {
    // The other half: a boundary DOES precede this run, so the anchors were never
    // the problem here — only the clamp-then-redact order was.
    const rendered = quoteSummaryValue(`${'a'.repeat(60)} ${TOKEN}`);

    expect(rendered).not.toContain(PREFIX);
    expect(rendered).toContain(REDACTED_SUMMARY_VALUE);
  });

  it('hides a token buried between padding on both sides', () => {
    const rendered = quoteSummaryValue(`${'x'.repeat(60)}${TOKEN}${'y'.repeat(60)}`);
    expect(rendered).not.toContain(PREFIX);
  });

  it('still caps length after redacting, so one value cannot crowd out another', () => {
    // Redaction only ever shortens, so the cap is unaffected by the reordering.
    const rendered = quoteSummaryValue('z'.repeat(500));
    expect(rendered.length).toBeLessThanOrEqual(82); // 80 + the two quotes
    expect(rendered).toContain('…');
  });

  it('caps a value that is still too long even after redaction', () => {
    const rendered = quoteSummaryValue(`${'z'.repeat(200)}${TOKEN}`);
    expect(rendered).not.toContain(PREFIX);
    expect(rendered.length).toBeLessThanOrEqual(82);
  });
});

describe('renderRequesterLabel', () => {
  it('passes an ordinary agent name through untouched', () => {
    expect(renderRequesterLabel('DorkBot')).toBe('DorkBot');
  });

  it('hides a token-shaped label', () => {
    expect(renderRequesterLabel(TOKEN)).toBe(REDACTED_SUMMARY_VALUE);
  });

  it('hides a token PADDED past the label cap', () => {
    // 40 + 32 = 72 characters, over the 60-char label cap. Clamping first left 19
    // hex characters of a foreign secret on every connected cockpit.
    const rendered = renderRequesterLabel(`${'n'.repeat(40)}${TOKEN}`);

    expect(rendered).not.toContain(PREFIX);
    expect(rendered).toContain(REDACTED_SUMMARY_VALUE);
  });

  it('hides a token glued to a self-chosen agent name', () => {
    expect(renderRequesterLabel(`DorkBot${TOKEN}`)).toBe(`DorkBot${REDACTED_SUMMARY_VALUE}`);
  });

  it('still caps length after redacting', () => {
    expect(renderRequesterLabel('A'.repeat(500)).length).toBeLessThanOrEqual(60);
  });
});
