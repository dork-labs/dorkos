/**
 * Every public route's throttle policy in one place (DOR-1586).
 *
 * Two things are checked here that no single route's test can check:
 * the chosen numbers, side by side, so loosening one is a visible decision
 * rather than a drift; and the isolation between them, which is a property of
 * the set, not of any one member.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FEEDBACK_RATE_LIMIT,
  FEEDBACK_RATE_WINDOW_MS,
  consumeFeedbackQuota,
  resetFeedbackRateLimit,
} from '@/lib/feedback/submit-rate-limit';
import {
  CONFIRM_RATE_LIMIT,
  CONFIRM_RATE_WINDOW_MS,
  consumeConfirmQuota,
  resetConfirmRateLimit,
} from '@/lib/newsletter/confirm-rate-limit';
import {
  SUBSCRIBE_RATE_LIMIT,
  SUBSCRIBE_RATE_WINDOW_MS,
  consumeSubscribeQuota,
  resetSubscribeRateLimit,
} from '@/lib/newsletter/subscribe-rate-limit';
import {
  UNSUBSCRIBE_RATE_LIMIT,
  UNSUBSCRIBE_RATE_WINDOW_MS,
  consumeUnsubscribeQuota,
  resetUnsubscribeRateLimit,
} from '@/lib/newsletter/unsubscribe-rate-limit';
import {
  EVENTS_TELEMETRY_RATE_LIMIT,
  EVENTS_TELEMETRY_RATE_WINDOW_MS,
  consumeEventsTelemetryQuota,
  resetEventsTelemetryRateLimit,
} from '@/lib/telemetry/events-rate-limit';
import {
  HEARTBEAT_TELEMETRY_RATE_LIMIT,
  HEARTBEAT_TELEMETRY_RATE_WINDOW_MS,
  consumeHeartbeatTelemetryQuota,
  resetHeartbeatTelemetryRateLimit,
} from '@/lib/telemetry/heartbeat-rate-limit';
import {
  INSTALL_TELEMETRY_RATE_LIMIT,
  INSTALL_TELEMETRY_RATE_WINDOW_MS,
  consumeInstallTelemetryQuota,
  resetInstallTelemetryRateLimit,
} from '@/lib/telemetry/install-rate-limit';

import type { RateLimitDecision } from '../fixed-window';

/** One throttled route, as this suite needs to see it. */
interface RoutePolicy {
  name: string;
  limit: number;
  windowMs: number;
  consume: (request: Request, now?: number) => RateLimitDecision;
  reset: () => void;
}

/**
 * The chosen policy for every throttled public route. The numbers are pinned
 * deliberately: each is argued in its own module's doc, and changing one is a
 * product decision that should fail here and be re-argued, not drift.
 */
const POLICIES: RoutePolicy[] = [
  {
    name: 'POST /api/newsletter/subscribe',
    limit: 5,
    windowMs: 600_000,
    consume: consumeSubscribeQuota,
    reset: resetSubscribeRateLimit,
  },
  {
    name: 'GET /api/newsletter/confirm',
    limit: 30,
    windowMs: 600_000,
    consume: consumeConfirmQuota,
    reset: resetConfirmRateLimit,
  },
  {
    name: '/api/newsletter/unsubscribe',
    limit: 60,
    windowMs: 600_000,
    consume: consumeUnsubscribeQuota,
    reset: resetUnsubscribeRateLimit,
  },
  {
    name: 'POST /api/feedback',
    limit: 10,
    windowMs: 600_000,
    consume: consumeFeedbackQuota,
    reset: resetFeedbackRateLimit,
  },
  {
    name: 'POST /api/telemetry/install',
    limit: 120,
    windowMs: 600_000,
    consume: consumeInstallTelemetryQuota,
    reset: resetInstallTelemetryRateLimit,
  },
  {
    name: 'POST /api/telemetry/heartbeat',
    limit: 60,
    windowMs: 600_000,
    consume: consumeHeartbeatTelemetryQuota,
    reset: resetHeartbeatTelemetryRateLimit,
  },
  {
    name: 'POST /api/telemetry/events',
    limit: 600,
    windowMs: 600_000,
    consume: consumeEventsTelemetryQuota,
    reset: resetEventsTelemetryRateLimit,
  },
];

const NOW = 1_700_000_000_000;

function request(ip: string): Request {
  return new Request('https://dorkos.ai/api/anything', {
    method: 'POST',
    headers: { 'x-real-ip': ip },
  });
}

/** Spend a policy's whole allowance for one IP. */
function exhaust(policy: RoutePolicy, ip: string): void {
  for (let i = 0; i < policy.limit; i += 1) policy.consume(request(ip), NOW);
}

beforeEach(() => {
  for (const policy of POLICIES) policy.reset();
});

describe('the exported constants match the policy table', () => {
  // The table above is what the isolation tests below drive, so it has to be
  // the same numbers the modules export — otherwise this suite would be
  // proving things about a table nobody ships.
  it.each([
    ['subscribe', SUBSCRIBE_RATE_LIMIT, SUBSCRIBE_RATE_WINDOW_MS, 5],
    ['confirm', CONFIRM_RATE_LIMIT, CONFIRM_RATE_WINDOW_MS, 30],
    ['unsubscribe', UNSUBSCRIBE_RATE_LIMIT, UNSUBSCRIBE_RATE_WINDOW_MS, 60],
    ['feedback', FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_MS, 10],
    ['install telemetry', INSTALL_TELEMETRY_RATE_LIMIT, INSTALL_TELEMETRY_RATE_WINDOW_MS, 120],
    ['heartbeat telemetry', HEARTBEAT_TELEMETRY_RATE_LIMIT, HEARTBEAT_TELEMETRY_RATE_WINDOW_MS, 60],
    ['events telemetry', EVENTS_TELEMETRY_RATE_LIMIT, EVENTS_TELEMETRY_RATE_WINDOW_MS, 600],
  ])('%s is %d per ten minutes', (_name, limit, windowMs, expected) => {
    expect(limit).toBe(expected);
    expect(windowMs).toBe(600_000);
  });
});

describe.each(POLICIES.map((p) => [p.name, p] as const))('%s', (_name, policy) => {
  it('allows exactly its limit, then answers with a full-window retry', () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < policy.limit; i += 1) {
      expect(policy.consume(request(ip), NOW).allowed).toBe(true);
    }

    const denied = policy.consume(request(ip), NOW);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(policy.windowMs / 1000);
  });

  it('meters each IP on its own', () => {
    exhaust(policy, '203.0.113.10');
    expect(policy.consume(request('203.0.113.10'), NOW).allowed).toBe(false);
    expect(policy.consume(request('203.0.113.11'), NOW).allowed).toBe(true);
  });
});

describe('bucket isolation between routes', () => {
  it('leaves every other route untouched when one is flooded from the same IP', () => {
    const ip = '203.0.113.10';

    for (const flooded of POLICIES) {
      for (const policy of POLICIES) policy.reset();

      exhaust(flooded, ip);
      expect(flooded.consume(request(ip), NOW).allowed).toBe(false);

      for (const bystander of POLICIES) {
        if (bystander === flooded) continue;
        expect(
          bystander.consume(request(ip), NOW).allowed,
          `${flooded.name} flooding starved ${bystander.name}`
        ).toBe(true);
      }
    }
  });
});
