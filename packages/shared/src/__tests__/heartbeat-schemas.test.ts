import { describe, it, expect } from 'vitest';
import {
  EndBeatInputSchema,
  HeartbeatFrontmatterSchema,
  parseHeartbeatInterval,
  resolveHeartbeatSettings,
} from '../heartbeat-schemas.js';

describe('resolveHeartbeatSettings', () => {
  it('reads no file as events, every gatherer but workspace, a daily report and no sweep', () => {
    expect(resolveHeartbeatSettings(null)).toEqual({
      wake: 'events',
      watch: ['addressed', 'commitments', 'schedules', 'health'],
      report: 'daily',
      sweepMs: null,
    });
  });

  it('keeps the registry order and drops repeats in watch', () => {
    const settings = resolveHeartbeatSettings(
      HeartbeatFrontmatterSchema.parse({ watch: ['workspace', 'addressed', 'workspace'] })
    );
    expect(settings.watch).toEqual(['addressed', 'workspace']);
  });

  it('turns a sweep into milliseconds', () => {
    expect(resolveHeartbeatSettings({ sweep: '1h30m' }).sweepMs).toBe(90 * 60 * 1000);
    expect(parseHeartbeatInterval('nonsense')).toBe(0);
  });

  it('ignores keys it does not know, so a newer file still loads', () => {
    expect(HeartbeatFrontmatterSchema.safeParse({ wake: 'off', future: 1 }).success).toBe(true);
  });
});

describe('EndBeatInputSchema', () => {
  it('needs a roomId on a room raise', () => {
    const base = { summary: 'Checked.', raises: [{ text: 'Look', rung: 'room' as const }] };
    expect(EndBeatInputSchema.safeParse(base).success).toBe(false);
    base.raises[0] = { ...base.raises[0]!, roomId: 'r1' } as never;
    expect(EndBeatInputSchema.safeParse(base).success).toBe(true);
  });

  it('bounds the pace to 5–60 minutes', () => {
    const pace = { everyMinutes: 2, untilIso: '2026-10-10T18:00:00Z', why: 'launch' };
    expect(EndBeatInputSchema.safeParse({ summary: 'x', pace }).success).toBe(false);
    expect(
      EndBeatInputSchema.safeParse({ summary: 'x', pace: { ...pace, everyMinutes: 5 } }).success
    ).toBe(true);
  });

  it('refuses a faster pace that lasts longer than twelve hours', () => {
    const at = (hours: number) => new Date(Date.now() + hours * 60 * 60_000).toISOString();
    const pace = (untilIso: string) => ({ everyMinutes: 10, untilIso, why: 'launch day' });
    expect(EndBeatInputSchema.safeParse({ summary: 'x', pace: pace(at(11)) }).success).toBe(true);
    expect(EndBeatInputSchema.safeParse({ summary: 'x', pace: pace(at(13)) }).success).toBe(false);
  });

  it('caps the summary at 200 characters and the raises at ten', () => {
    expect(EndBeatInputSchema.safeParse({ summary: 'x'.repeat(201) }).success).toBe(false);
    const raises = Array.from({ length: 11 }, () => ({ text: 'a', rung: 'dm' as const }));
    expect(EndBeatInputSchema.safeParse({ summary: 'x', raises }).success).toBe(false);
  });
});
