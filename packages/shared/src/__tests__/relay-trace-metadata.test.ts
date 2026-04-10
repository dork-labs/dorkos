import { describe, it, expect } from 'vitest';
import { TraceMetadataSchema, type TraceMetadata } from '../relay-trace-schemas.js';
import { BindingTestResultSchema, type BindingTestResult } from '../relay-adapter-schemas.js';

describe('TraceMetadataSchema', () => {
  it('accepts metadata without isSyntheticTest (backward compat)', () => {
    const result = TraceMetadataSchema.safeParse({
      adapterId: 'telegram-1',
      chatId: '12345',
    });
    expect(result.success).toBe(true);
  });

  it('accepts metadata with isSyntheticTest: true', () => {
    const result = TraceMetadataSchema.safeParse({
      adapterId: 'telegram-1',
      isSyntheticTest: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSyntheticTest).toBe(true);
    }
  });

  it('accepts metadata with isSyntheticTest: false', () => {
    const result = TraceMetadataSchema.safeParse({
      adapterId: 'telegram-1',
      isSyntheticTest: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSyntheticTest).toBe(false);
    }
  });

  it('defaults isSyntheticTest to undefined when omitted', () => {
    const result = TraceMetadataSchema.safeParse({
      adapterId: 'telegram-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSyntheticTest).toBeUndefined();
    }
  });

  it('rejects non-boolean isSyntheticTest', () => {
    const result = TraceMetadataSchema.safeParse({
      adapterId: 'telegram-1',
      isSyntheticTest: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('passes through additional metadata fields', () => {
    const result = TraceMetadataSchema.safeParse({
      adapterId: 'telegram-1',
      chatId: '12345',
      userId: 'user-abc',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chatId).toBe('12345');
      expect(result.data.userId).toBe('user-abc');
    }
  });

  it('satisfies the TraceMetadata type', () => {
    const meta: TraceMetadata = {
      isSyntheticTest: true,
      adapterId: 'test',
    };
    expect(meta.isSyntheticTest).toBe(true);
  });
});

describe('BindingTestResultSchema', () => {
  it('accepts a successful test result', () => {
    const result = BindingTestResultSchema.safeParse({
      ok: true,
      resolved: true,
      latencyMs: 42,
      wouldDeliverTo: 'agent-1',
      details: 'Routing succeeded. No agent was invoked.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.resolved).toBe(true);
      expect(result.data.latencyMs).toBe(42);
      expect(result.data.wouldDeliverTo).toBe('agent-1');
      expect(result.data.details).toBe('Routing succeeded. No agent was invoked.');
    }
  });

  it('accepts a failed test result', () => {
    const result = BindingTestResultSchema.safeParse({
      ok: false,
      resolved: false,
      latencyMs: 15,
      reason: 'No matching enabled binding',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(false);
      expect(result.data.resolved).toBe(false);
      expect(result.data.reason).toBe('No matching enabled binding');
    }
  });

  it('accepts minimal result with only required fields', () => {
    const result = BindingTestResultSchema.safeParse({
      ok: true,
      resolved: true,
      latencyMs: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wouldDeliverTo).toBeUndefined();
      expect(result.data.reason).toBeUndefined();
      expect(result.data.details).toBeUndefined();
    }
  });

  it('rejects missing required fields', () => {
    expect(BindingTestResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(BindingTestResultSchema.safeParse({ resolved: true }).success).toBe(false);
    expect(BindingTestResultSchema.safeParse({ latencyMs: 10 }).success).toBe(false);
  });

  it('rejects invalid field types', () => {
    expect(
      BindingTestResultSchema.safeParse({
        ok: 'yes',
        resolved: true,
        latencyMs: 10,
      }).success
    ).toBe(false);

    expect(
      BindingTestResultSchema.safeParse({
        ok: true,
        resolved: true,
        latencyMs: 'fast',
      }).success
    ).toBe(false);
  });

  it('satisfies the BindingTestResult type', () => {
    const result: BindingTestResult = {
      ok: true,
      resolved: true,
      latencyMs: 100,
      wouldDeliverTo: 'agent-1',
    };
    expect(result.ok).toBe(true);
  });
});
