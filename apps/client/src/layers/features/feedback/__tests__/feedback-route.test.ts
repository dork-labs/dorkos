import { describe, it, expect } from 'vitest';
import { MAX_FEEDBACK_ROUTE_LEN } from '@dorkos/shared/telemetry-events';
import { buildFeedbackRoute, ROUTE_QUERY_ALLOWLIST } from '../lib/feedback-route';

describe('buildFeedbackRoute', () => {
  it('keeps the identifying query param', () => {
    // The whole reason this change exists: `/session` alone does not say which
    // conversation broke.
    expect(buildFeedbackRoute('/session', '?session=sess_abc123')).toBe(
      '/session?session=sess_abc123'
    );
  });

  it('returns a bare pathname when nothing is allowlisted', () => {
    expect(buildFeedbackRoute('/team', '')).toBe('/team');
    expect(buildFeedbackRoute('/team', '?q=dorian')).toBe('/team');
  });

  describe('never carries what a URL should not leak', () => {
    it('drops ?dir=, which is the absolute working directory', () => {
      // router.tsx writes `dir: dir ?? resolved.cwd` on EVERY /session
      // navigation, so this is the common case, not an edge case. A route is
      // stored in Neon, folded into a Linear issue, and sent to PostHog —
      // outside the Diagnostics toggle — so a home path here is a real leak.
      const route = buildFeedbackRoute(
        '/session',
        '?dir=%2FUsers%2Fdorian%2Fclients%2Facme&session=sess_abc'
      );

      expect(route).toBe('/session?session=sess_abc');
      expect(route).not.toContain('dir');
      expect(route).not.toContain('Users');
      expect(route).not.toContain('acme');
    });

    it('drops the text the user typed to an agent', () => {
      const route = buildFeedbackRoute(
        '/session',
        '?prompt=refactor%20my%20billing%20code&message=hello%20there&seed=dorkbot-help&session=s1'
      );

      expect(route).toBe('/session?session=s1');
      expect(route).not.toContain('billing');
      expect(route).not.toContain('hello');
    });

    it('drops the roster and marketplace search boxes', () => {
      expect(buildFeedbackRoute('/team', '?q=priya&view=table')).toBe('/team?view=table');
      expect(buildFeedbackRoute('/marketplace', '?q=secret%20thing&pkg=flow')).toBe(
        '/marketplace?pkg=flow'
      );
    });

    it('drops ?agentPath=, the other filesystem path in a URL', () => {
      const route = buildFeedbackRoute('/team', '?agentPath=%2FUsers%2Fdorian%2Fvault&agent=a1');

      expect(route).toBe('/team?agent=a1');
      expect(route).not.toContain('vault');
    });

    it('drops an unknown param a future route might add', () => {
      // The allowlist fails CLOSED: a param nobody here has heard of is not
      // carried, which is the property a denylist could not give.
      expect(buildFeedbackRoute('/session', '?somethingNew=abc&session=s1')).toBe(
        '/session?session=s1'
      );
    });
  });

  describe('budget', () => {
    it('spends the budget on the identifier before the view state', () => {
      // On a real URL `dir` and `prompt` come BEFORE `session`. Serializing in
      // arrival order spent the cap on params that get dropped and could push
      // the session id off the end — so ordering here is the fix, not luck.
      const bigDir = `%2FUsers%2Fdorian%2F${'deep%2F'.repeat(60)}`;
      const route = buildFeedbackRoute(
        '/session',
        `?dir=${bigDir}&prompt=${'x'.repeat(300)}&session=sess_survivor&view=table`
      );

      expect(route).toContain('session=sess_survivor');
      expect(route.length).toBeLessThanOrEqual(MAX_FEEDBACK_ROUTE_LEN);
    });

    it('keeps the identifier and sheds view state when both cannot fit', () => {
      // Sized so `/channels?id=<longId>` fits with ~7 chars spare and the
      // 11-char `&view=table` cannot follow it.
      const longId = 'i'.repeat(MAX_FEEDBACK_ROUTE_LEN - 20);
      const route = buildFeedbackRoute('/channels', `?view=table&id=${longId}`);

      expect(route).toContain(`id=${longId}`);
      expect(route).not.toContain('view');
      expect(route.length).toBeLessThanOrEqual(MAX_FEEDBACK_ROUTE_LEN);
    });

    it('never exceeds the cap, and never cuts a param or an escape in half', () => {
      // A sliced `%2` is not a shorter path, it is a corrupt one — and an
      // over-cap route fails the strict wire schema, losing the whole report.
      const route = buildFeedbackRoute(
        '/session',
        `?session=${'%2F'.repeat(200)}&id=${'%2F'.repeat(200)}&view=table`
      );

      expect(route.length).toBeLessThanOrEqual(MAX_FEEDBACK_ROUTE_LEN);
      // Every kept piece is a whole `key=value`, so re-parsing loses nothing
      // and no trailing fragment survives.
      const [path, query] = route.split('?');
      expect(path).toBe('/session');
      if (query) {
        for (const piece of query.split('&')) {
          const [key] = piece.split('=');
          expect(ROUTE_QUERY_ALLOWLIST).toContain(key);
          expect(() => decodeURIComponent(piece.split('=')[1] ?? '')).not.toThrow();
        }
      }
    });

    it('bounds a pathname that is over the cap on its own', () => {
      const route = buildFeedbackRoute(`/${'p'.repeat(400)}`, '?session=s1');

      expect(route.length).toBe(MAX_FEEDBACK_ROUTE_LEN);
    });
  });

  it('carries every allowlisted key when they all fit', () => {
    // Pins the allowlist itself: a key removed from the array stops appearing,
    // so the TSDoc's enumeration stays checkable rather than decorative.
    const search = ROUTE_QUERY_ALLOWLIST.map((key) => `${key}=v`).join('&');
    const route = buildFeedbackRoute('/x', `?${search}`);

    for (const key of ROUTE_QUERY_ALLOWLIST) {
      expect(route).toContain(`${key}=v`);
    }
  });

  it('allowlists no param that carries a path, prose, or a free-form filter', () => {
    // The negative half of the same contract, stated by name so adding one of
    // these to the array is a test failure and not a review miss.
    for (const forbidden of [
      'dir',
      'agentPath',
      'prompt',
      'message',
      'seed',
      'q',
      'owner',
      'actorId',
      'categories',
      'category',
      'source',
      'since',
      'sort',
      'settings',
      'settingsSection',
      'hubTab',
    ]) {
      expect(ROUTE_QUERY_ALLOWLIST).not.toContain(forbidden);
    }
  });
});
