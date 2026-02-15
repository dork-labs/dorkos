export type CelebrationLevel = 'mini' | 'major';

export interface CelebrationEvent {
  level: CelebrationLevel;
  taskId: string;
  timestamp: number;
}

export interface CelebrationEngineConfig {
  enabled: boolean;
  miniProbability: number;       // 0.3 = 30%
  debounceWindowMs: number;      // 2000
  debounceThreshold: number;     // 3
  minTasksForMajor: number;      // 3
  idleTimeoutMs: number;         // 30000
  onCelebrate: (event: CelebrationEvent) => void;
}

export class CelebrationEngine {
  private config: CelebrationEngineConfig;
  private recentCompletions: number[] = [];
  private queue: CelebrationEvent[] = [];
  private isIdle = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: CelebrationEngineConfig) {
    this.config = config;
  }

  /** Called when a task transitions to 'completed' (live updates only) */
  onTaskCompleted(taskId: string, allTasks: { id: string; status: string }[]): void {
    if (!this.config.enabled) return;

    const now = Date.now();
    this.recentCompletions.push(now);

    // Clean up old completions outside debounce window
    this.recentCompletions = this.recentCompletions.filter(
      (t) => now - t < this.config.debounceWindowMs,
    );

    // Check if all tasks are completed (major celebration)
    const totalTasks = allTasks.length;
    const completedTasks = allTasks.filter((t) => t.status === 'completed').length;
    const allDone = totalTasks >= this.config.minTasksForMajor && completedTasks === totalTasks;

    if (allDone) {
      this.cancelDebounce();
      const event: CelebrationEvent = { level: 'major', taskId, timestamp: now };
      this.emitOrQueue(event);
      return;
    }

    // Debounce check: if many completions happening rapidly, wait and batch
    if (this.recentCompletions.length >= this.config.debounceThreshold) {
      this.cancelDebounce();
      // Batch mode: wait for debounce window then fire single celebration
      this.debounceTimer = setTimeout(() => {
        const batchEvent: CelebrationEvent = { level: 'mini', taskId, timestamp: Date.now() };
        this.emitOrQueue(batchEvent);
        this.recentCompletions = [];
      }, this.config.debounceWindowMs);
      return;
    }

    // Probabilistic mini celebration
    if (Math.random() < this.config.miniProbability) {
      const event: CelebrationEvent = { level: 'mini', taskId, timestamp: now };
      this.emitOrQueue(event);
    }
  }

  setIdle(idle: boolean): void {
    this.isIdle = idle;
  }

  onUserReturn(): void {
    // Replay queued celebrations
    if (this.queue.length > 0) {
      // If there are queued celebrations, play the highest priority one
      const hasMajor = this.queue.some((e) => e.level === 'major');
      const event = hasMajor
        ? this.queue.find((e) => e.level === 'major')!
        : this.queue[this.queue.length - 1];
      this.config.onCelebrate(event);
      this.queue = [];
    }
  }

  destroy(): void {
    this.cancelDebounce();
    this.queue = [];
    this.recentCompletions = [];
  }

  private emitOrQueue(event: CelebrationEvent): void {
    if (this.isIdle) {
      this.queue.push(event);
    } else {
      this.config.onCelebrate(event);
    }
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
