import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchedulerService, buildPulseAppend, type SchedulerAgentManager } from '../scheduler-service.js';
import { PulseStore } from '../pulse-store.js';
import { createTestDb } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import type { PulseSchedule, PulseRun } from '@dorkos/shared/types';
import type { RelayCore } from '@dorkos/relay';
import type { PulseDispatchPayload } from '@dorkos/shared/relay-schemas';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
}));

import { isRelayEnabled } from '../../relay/relay-state.js';

function createMockAgentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {
      // Default: no events (immediate completion)
    }),
  } as SchedulerAgentManager;
}

const DEFAULT_CONFIG = {
  maxConcurrentRuns: 1,
  retentionCount: 100,
  timezone: null,
};

describe('SchedulerService', () => {
  let store: PulseStore;
  let db: Db;
  let mockAgent: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    db = createTestDb();
    store = new PulseStore(db);
    mockAgent = createMockAgentManager();
  });

  describe('start()', () => {
    it('marks interrupted running runs as failed on startup', async () => {
      // Create a schedule + "running" run that simulates a crash
      const sched = store.createSchedule({ name: 'Crash', prompt: 'test', cron: '0 * * * *' });
      store.createRun(sched.id, 'scheduled');

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const runs = store.listRuns();
      expect(runs[0].status).toBe('failed');
      expect(runs[0].error).toBe('Interrupted by server restart');

      await service.stop();
    });

    it('registers cron jobs for enabled active schedules', async () => {
      store.createSchedule({ name: 'Active', prompt: 'test', cron: '0 * * * *' });
      store.createSchedule({ name: 'Disabled', prompt: 'test', cron: '0 * * * *', enabled: false });

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const schedules = store.getSchedules();
      expect(service.isRegistered(schedules[0].id)).toBe(true);
      expect(service.isRegistered(schedules[1].id)).toBe(false);

      await service.stop();
    });

    it('skips schedules with pending_approval status', async () => {
      const sched = store.createSchedule({ name: 'Pending', prompt: 'test', cron: '0 * * * *' });
      store.updateSchedule(sched.id, { status: 'pending_approval' });

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      expect(service.isRegistered(sched.id)).toBe(false);

      await service.stop();
    });
  });

  describe('triggerManualRun()', () => {
    it('creates a run with manual trigger', async () => {
      const sched = store.createSchedule({ name: 'Manual', prompt: 'do stuff', cron: '0 * * * *' });

      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'Done!' } };
      });

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(sched.id);

      expect(run).not.toBeNull();
      expect(run!.trigger).toBe('manual');
      expect(run!.status).toBe('running');

      // Wait for async execution
      await new Promise((r) => setTimeout(r, 100));

      await service.stop();
    });

    it('passes systemPromptAppend with pulse context to sendMessage', async () => {
      const sched = store.createSchedule({
        name: 'Context Test',
        prompt: 'do stuff',
        cron: '0 * * * *',
      });

      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        // no events
      });

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.triggerManualRun(sched.id);

      // Wait for async execution to complete
      await new Promise((r) => setTimeout(r, 100));

      expect(mockAgent.sendMessage).toHaveBeenCalledOnce();
      const [, , opts] = vi.mocked(mockAgent.sendMessage).mock.calls[0];
      expect(opts?.systemPromptAppend).toBeDefined();
      expect(opts?.systemPromptAppend).toContain('PULSE SCHEDULER CONTEXT');
      expect(opts?.systemPromptAppend).toContain('Context Test');

      await service.stop();
    });

    it('returns null for nonexistent schedule', async () => {
      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun('nonexistent');
      expect(run).toBeNull();
      await service.stop();
    });
  });

  describe('cancelRun()', () => {
    it('returns false when run is not active', () => {
      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.cancelRun('nonexistent')).toBe(false);
    });
  });

  describe('getActiveRunCount()', () => {
    it('returns 0 when no runs are active', () => {
      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.getActiveRunCount()).toBe(0);
    });
  });

  describe('getNextRun()', () => {
    it('returns null for unregistered schedule', () => {
      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.getNextRun('nonexistent')).toBeNull();
    });

    it('returns a date for registered schedule', async () => {
      const sched = store.createSchedule({ name: 'Next', prompt: 'test', cron: '0 * * * *' });

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const next = service.getNextRun(sched.id);
      expect(next).toBeInstanceOf(Date);

      await service.stop();
    });
  });

  describe('registerSchedule / unregisterSchedule', () => {
    it('can register and unregister a schedule', () => {
      const sched = store.createSchedule({ name: 'Reg', prompt: 'test', cron: '0 * * * *' });

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      service.registerSchedule(sched);
      expect(service.isRegistered(sched.id)).toBe(true);

      service.unregisterSchedule(sched.id);
      expect(service.isRegistered(sched.id)).toBe(false);
    });

    it('replaces existing cron job on re-register', () => {
      const sched = store.createSchedule({ name: 'Re-reg', prompt: 'test', cron: '0 * * * *' });

      const service = new SchedulerService(store, mockAgent, DEFAULT_CONFIG);
      service.registerSchedule(sched);
      service.registerSchedule(sched); // Should not throw
      expect(service.isRegistered(sched.id)).toBe(true);
    });
  });

  describe('executeRunViaRelay (via triggerManualRun)', () => {
    let mockRelay: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(true);
      mockRelay = {
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      };
    });

    afterEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(false);
    });

    it('publishes envelope with correct subject relay.system.pulse.{scheduleId}', async () => {
      const sched = store.createSchedule({
        name: 'Relay Test',
        prompt: 'do relay stuff',
        cron: '0 * * * *',
      });

      const service = new SchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(sched.id);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRelay.publish).toHaveBeenCalledOnce();
      const [subject] = mockRelay.publish.mock.calls[0];
      expect(subject).toBe(`relay.system.pulse.${sched.id}`);

      await service.stop();
    });

    it('publishes PulseDispatchPayload with all expected fields', async () => {
      const sched = store.createSchedule({
        name: 'Payload Test',
        prompt: 'run this task',
        cron: '30 2 * * *',
        cwd: '/tmp/test-cwd',
        permissionMode: 'acceptEdits',
      });

      const service = new SchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(sched.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, payload, options] = mockRelay.publish.mock.calls[0];
      const dispatch = payload as PulseDispatchPayload;

      expect(dispatch.type).toBe('pulse_dispatch');
      expect(dispatch.scheduleId).toBe(sched.id);
      expect(dispatch.runId).toEqual(expect.any(String));
      expect(dispatch.prompt).toBe('run this task');
      expect(dispatch.cwd).toBe('/tmp/test-cwd');
      expect(dispatch.permissionMode).toBe('acceptEdits');
      expect(dispatch.scheduleName).toBe('Payload Test');
      expect(dispatch.cron).toBe('30 2 * * *');
      expect(dispatch.trigger).toBe('manual');

      // Verify publish options
      expect(options.from).toBe('relay.system.pulse.scheduler');
      expect(options.replyTo).toBe(`relay.system.pulse.${sched.id}.response`);
      expect(options.budget.maxHops).toBe(3);
      expect(options.budget.callBudgetRemaining).toBe(5);

      await service.stop();
    });

    it('marks run as failed when deliveredTo is 0', async () => {
      mockRelay.publish.mockResolvedValue({ messageId: 'msg-2', deliveredTo: 0 });

      const sched = store.createSchedule({
        name: 'No Receiver',
        prompt: 'orphan task',
        cron: '0 * * * *',
      });

      const service = new SchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      const run = await service.triggerManualRun(sched.id);
      await new Promise((r) => setTimeout(r, 100));

      const updatedRun = store.listRuns({ scheduleId: sched.id }).find((r) => r.id === run!.id);
      expect(updatedRun?.status).toBe('failed');
      expect(updatedRun?.error).toBe('No receiver for pulse dispatch');

      await service.stop();
    });

    it('marks run as running on successful delivery', async () => {
      mockRelay.publish.mockResolvedValue({ messageId: 'msg-3', deliveredTo: 2 });

      const sched = store.createSchedule({
        name: 'Success Delivery',
        prompt: 'delivered task',
        cron: '0 * * * *',
      });

      const service = new SchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      const run = await service.triggerManualRun(sched.id);
      await new Promise((r) => setTimeout(r, 100));

      const updatedRun = store.listRuns({ scheduleId: sched.id }).find((r) => r.id === run!.id);
      expect(updatedRun?.status).toBe('running');

      await service.stop();
    });

    it('sets budget TTL based on schedule.maxRuntime', async () => {
      const sched = store.createSchedule({
        name: 'TTL Test',
        prompt: 'timed task',
        cron: '0 * * * *',
        maxRuntime: 600_000, // 10 minutes
      });

      const now = Date.now();
      const service = new SchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(sched.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, , options] = mockRelay.publish.mock.calls[0];
      // TTL should be roughly now + 600_000 (10 minutes)
      expect(options.budget.ttl).toBeGreaterThanOrEqual(now + 600_000 - 1000);
      expect(options.budget.ttl).toBeLessThanOrEqual(now + 600_000 + 5000);

      await service.stop();
    });

    it('uses default TTL of 1 hour when maxRuntime is null', async () => {
      const sched = store.createSchedule({
        name: 'Default TTL',
        prompt: 'no timeout task',
        cron: '0 * * * *',
      });

      const now = Date.now();
      const service = new SchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(sched.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, , options] = mockRelay.publish.mock.calls[0];
      // Default TTL: 3_600_000 (1 hour)
      expect(options.budget.ttl).toBeGreaterThanOrEqual(now + 3_600_000 - 1000);
      expect(options.budget.ttl).toBeLessThanOrEqual(now + 3_600_000 + 5000);

      await service.stop();
    });
  });
});

describe('buildPulseAppend', () => {
  it('produces system prompt with schedule info', () => {
    const schedule: PulseSchedule = {
      id: 'sched-1',
      name: 'Daily Cleanup',
      prompt: 'Clean temp files',
      cron: '0 2 * * *',
      timezone: null,
      cwd: '/home/user/project',
      enabled: true,
      maxRuntime: null,
      permissionMode: 'acceptEdits',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const run: PulseRun = {
      id: 'run-1',
      scheduleId: 'sched-1',
      status: 'running',
      startedAt: '2026-01-01T02:00:00Z',
      finishedAt: null,
      durationMs: null,
      outputSummary: null,
      error: null,
      sessionId: null,
      trigger: 'scheduled',
      createdAt: '2026-01-01T02:00:00Z',
    };

    const result = buildPulseAppend(schedule, run);
    expect(result).toContain('PULSE SCHEDULER CONTEXT');
    expect(result).toContain('Daily Cleanup');
    expect(result).toContain('0 2 * * *');
    expect(result).toContain('/home/user/project');
    expect(result).toContain('run-1');
    expect(result).toContain('scheduled');
    expect(result).toContain('unattended');
  });
});
