/**
 * The default-first decision (spec `dorkos-account-by-default` §3, D2): DorkOS
 * credits lead only where a runtime has no sign-in at all and the server
 * reports them wired for it.
 */
import { describe, expect, it } from 'vitest';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { creditsOfferFor, runsOnCredits } from '../lib/credits-offer';

function report(over: Partial<CloudCreditsStatus> = {}): CloudCreditsStatus {
  return {
    enabled: false,
    killed: false,
    linked: false,
    ready: false,
    runtimes: { 'claude-code': 'wired', codex: 'follow-up', opencode: 'follow-up' },
    ...over,
  };
}

const ON_CREDITS = report({
  enabled: true,
  linked: true,
  defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
});

describe('creditsOfferFor', () => {
  it('leads with credits only for a wired runtime with no sign-in at all, linked or not', () => {
    expect(creditsOfferFor('none', report(), 'claude-code')).toBe('lead');
    expect(creditsOfferFor('none', report({ enabled: true, linked: true }), 'claude-code')).toBe(
      'lead'
    );
  });

  it('never leads for a sign-in that expired or ran out', () => {
    expect(creditsOfferFor('needs-attention', report(), 'claude-code')).toBe('none');
  });

  it('never leads over a working sign-in, even one set to run on credits', () => {
    expect(creditsOfferFor('working', report(), 'claude-code')).toBe('none');
    expect(creditsOfferFor('working', ON_CREDITS, 'claude-code')).toBe('none');
  });

  it('follows the wired set, so a runtime that joins it is offered credits with no change here', () => {
    expect(creditsOfferFor('none', report(), 'codex')).toBe('none');
    expect(
      creditsOfferFor(
        'none',
        report({ runtimes: { 'claude-code': 'wired', codex: 'wired', opencode: 'follow-up' } }),
        'codex'
      )
    ).toBe('lead');
  });

  it('offers nothing while credits are switched off here, or before the report answers', () => {
    expect(creditsOfferFor('none', report({ killed: true }), 'claude-code')).toBe('none');
    expect(creditsOfferFor('none', undefined, 'claude-code')).toBe('none');
  });

  it('reads a runtime whose new work runs on credits as a working setup', () => {
    expect(creditsOfferFor('none', ON_CREDITS, 'claude-code')).toBe('on-credits');
    expect(runsOnCredits(ON_CREDITS, 'claude-code')).toBe(true);
    // Unlinked, nothing can run on credits whatever the record says.
    expect(runsOnCredits({ ...ON_CREDITS, enabled: false }, 'claude-code')).toBe(false);
  });
});
