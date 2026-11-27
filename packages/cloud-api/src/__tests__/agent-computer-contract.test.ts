/**
 * Cloud agent computers, the contract change of spec `cloud-agent-computers`
 * step Z1: the time-limit stop reason, the idle window, and the computer part
 * standing in its own module.
 *
 * The rules a later change could widen quietly: an older app reads the new
 * stop reason as unrecognised rather than failing the list, and the idle
 * window is a published number the app can check its own bounds against.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as agentComputers from '../agent-computers.js';
import { tolerantEnum } from '../primitives.js';
import {
  AGENT_COMPUTER_BUSY_MAX_SECONDS,
  AGENT_COMPUTER_BUSY_TTL_SECONDS,
  AGENT_COMPUTER_IDLE_WINDOW_SECONDS,
  CloudComputerListResponseSchema,
  CloudComputerStopReasonSchema,
  HubWakeResponseSchema,
  UNRECOGNISED,
} from '../index.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/** Read one fixture as a plain object. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

describe('the time-limit stop reason', () => {
  it('is a reason the app can show', () => {
    expect(CloudComputerStopReasonSchema.options).toContain('time_limit');
    const list = CloudComputerListResponseSchema.parse(fixture('hubs/computers.json'));
    expect(list.items.map((computer) => computer.stopReason)).toContain('time_limit');
  });

  it('reads as unrecognised in an app from before it, and keeps the rest of the list', () => {
    // What an older release knew: the list before `time_limit`.
    const older = z.object({
      items: z.array(
        z.object({
          stopReason: tolerantEnum(
            z.enum(['requested', 'idle', 'out_of_credits', 'held', 'suspended'])
          ).nullable(),
        })
      ),
    });
    const read = older.parse(fixture('hubs/computers.json'));
    expect(read.items.at(-1)?.stopReason).toBe(UNRECOGNISED);
    expect(read.items).toHaveLength(4);
  });
});

describe('the idle window', () => {
  it('is published, and is the stretch of idle that also counts as a break', () => {
    expect(AGENT_COMPUTER_IDLE_WINDOW_SECONDS).toBe(600);
    expect(AGENT_COMPUTER_IDLE_WINDOW_SECONDS).toBeGreaterThanOrEqual(
      AGENT_COMPUTER_BUSY_TTL_SECONDS
    );
    expect(AGENT_COMPUTER_IDLE_WINDOW_SECONDS).toBeLessThan(AGENT_COMPUTER_BUSY_MAX_SECONDS);
  });
});

describe('the computer part`s own module', () => {
  it('holds the computer schemas, and the package root still exports them', () => {
    expect(agentComputers.CloudComputerSchema).toBeDefined();
    expect(agentComputers.AgentComputerActivityRequestSchema).toBeDefined();
    expect(agentComputers.AGENT_COMPUTER_IDLE_WINDOW_SECONDS).toBe(
      AGENT_COMPUTER_IDLE_WINDOW_SECONDS
    );
  });
});

describe('the computer wake, widened', () => {
  it('names a cloud agent computer among those who may ask, in the schema`s own words', () => {
    expect(HubWakeResponseSchema.description).toContain('cloud agent computer');
  });
});
