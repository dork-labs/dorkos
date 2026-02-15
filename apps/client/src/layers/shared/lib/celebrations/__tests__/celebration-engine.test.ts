import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CelebrationEngine, type CelebrationEngineConfig } from '../celebration-engine';

function createConfig(overrides?: Partial<CelebrationEngineConfig>): CelebrationEngineConfig {
  return {
    enabled: true,
    miniProbability: 1.0, // Always trigger for predictable tests
    debounceWindowMs: 2000,
    debounceThreshold: 3,
    minTasksForMajor: 3,
    idleTimeoutMs: 30000,
    onCelebrate: vi.fn(),
    ...overrides,
  };
}

function makeTasks(statuses: string[]): { id: string; status: string }[] {
  return statuses.map((s, i) => ({ id: String(i + 1), status: s }));
}

describe('CelebrationEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing when disabled', () => {
    const config = createConfig({ enabled: false });
    const engine = new CelebrationEngine(config);
    engine.onTaskCompleted('1', makeTasks(['completed', 'pending']));
    expect(config.onCelebrate).not.toHaveBeenCalled();
  });

  it('fires mini celebration based on probability', () => {
    const config = createConfig({ miniProbability: 1.0 });
    const engine = new CelebrationEngine(config);
    engine.onTaskCompleted('1', makeTasks(['completed', 'pending']));
    expect(config.onCelebrate).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'mini', taskId: '1' })
    );
  });

  it('skips mini when probability is 0', () => {
    const config = createConfig({ miniProbability: 0 });
    const engine = new CelebrationEngine(config);
    engine.onTaskCompleted('1', makeTasks(['completed', 'pending']));
    expect(config.onCelebrate).not.toHaveBeenCalled();
  });

  it('fires major when all tasks completed and meets min threshold', () => {
    const config = createConfig({ minTasksForMajor: 3 });
    const engine = new CelebrationEngine(config);
    engine.onTaskCompleted('3', makeTasks(['completed', 'completed', 'completed']));
    expect(config.onCelebrate).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'major', taskId: '3' })
    );
  });

  it('does not fire major when below minTasksForMajor', () => {
    const config = createConfig({ minTasksForMajor: 3, miniProbability: 0 });
    const engine = new CelebrationEngine(config);
    engine.onTaskCompleted('2', makeTasks(['completed', 'completed']));
    expect(config.onCelebrate).not.toHaveBeenCalled();
  });

  it('debounces rapid completions', () => {
    const config = createConfig({ debounceThreshold: 3, debounceWindowMs: 2000, miniProbability: 0 });
    const engine = new CelebrationEngine(config);
    const tasks = makeTasks(['completed', 'pending', 'pending', 'pending']);
    engine.onTaskCompleted('1', tasks);
    engine.onTaskCompleted('2', tasks);
    engine.onTaskCompleted('3', tasks);
    expect(config.onCelebrate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(config.onCelebrate).toHaveBeenCalledOnce();
    expect(config.onCelebrate).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'mini' })
    );
  });

  it('queues celebrations when idle', () => {
    const config = createConfig({ miniProbability: 1.0 });
    const engine = new CelebrationEngine(config);
    engine.setIdle(true);
    engine.onTaskCompleted('1', makeTasks(['completed', 'pending']));
    expect(config.onCelebrate).not.toHaveBeenCalled();
  });

  it('replays queued celebrations on user return', () => {
    const config = createConfig({ miniProbability: 1.0 });
    const engine = new CelebrationEngine(config);
    engine.setIdle(true);
    engine.onTaskCompleted('1', makeTasks(['completed', 'pending']));
    engine.setIdle(false);
    engine.onUserReturn();
    expect(config.onCelebrate).toHaveBeenCalledOnce();
  });

  it('replays major over mini when both queued', () => {
    const config = createConfig({ miniProbability: 1.0, minTasksForMajor: 2 });
    const engine = new CelebrationEngine(config);
    engine.setIdle(true);
    engine.onTaskCompleted('1', makeTasks(['completed', 'pending']));
    engine.onTaskCompleted('2', makeTasks(['completed', 'completed']));
    engine.setIdle(false);
    engine.onUserReturn();
    expect(config.onCelebrate).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'major' })
    );
  });

  it('cleans up on destroy', () => {
    const config = createConfig({ debounceThreshold: 3, miniProbability: 0 });
    const engine = new CelebrationEngine(config);
    const tasks = makeTasks(['completed', 'pending', 'pending', 'pending']);
    engine.onTaskCompleted('1', tasks);
    engine.onTaskCompleted('2', tasks);
    engine.onTaskCompleted('3', tasks);
    engine.destroy();
    vi.advanceTimersByTime(5000);
    expect(config.onCelebrate).not.toHaveBeenCalled();
  });
});
