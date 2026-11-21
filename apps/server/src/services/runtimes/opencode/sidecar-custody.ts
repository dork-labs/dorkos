/** Structural subset of the private injected run port. Production needs no test package. */
export interface SidecarSpawnPort {
  start(
    request: {
      executable: string;
      argv: readonly string[];
      cwd: string;
      env: Readonly<NodeJS.ProcessEnv>;
      stdio: { stdin: 'ignore'; stdout: 'pipe'; stderr: 'pipe' };
      deadline: number;
    },
    signal: AbortSignal
  ): Promise<SidecarRunChild>;
}

type Read = { kind: 'bytes'; frame: Uint8Array } | { kind: 'eof' } | { kind: 'error' };
interface Reader {
  read(): Promise<Read>;
}
interface SidecarRunChild {
  pid: number;
  spawn: Promise<{ kind: 'spawned'; pid: number }>;
  exit: Promise<
    { kind: 'exited'; code: number | null; signal: string | null } | { kind: 'unobserved' }
  >;
  close: Promise<
    | { kind: 'native-closed'; integrity: 'verified' | 'failed' | 'unobserved' }
    | { kind: 'transport-lost' | 'unobserved' }
  >;
  stdout?: Reader;
  stderr?: Reader;
  stopAndJoin(
    reason: string,
    deadline: number
  ): Promise<{
    kind: 'cleaned-owned' | 'never-acquired' | 'cleanup-uncertain';
  }>;
}

const JOIN_MS = 5_000;
const READY_LINE = /opencode server listening on\s+(https?:\/\/\S+)\s/;

function cleanupUncertain(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('outcome' in error)) return false;
  const outcome = error.outcome;
  if (!outcome || typeof outcome !== 'object' || !('cleanup' in outcome)) return false;
  const cleanup = outcome.cleanup;
  return Boolean(
    cleanup &&
    typeof cleanup === 'object' &&
    'kind' in cleanup &&
    cleanup.kind === 'cleanup-uncertain'
  );
}

/** One injected sidecar attempt, including readiness and retirement. */
export class SidecarCustodyAttempt {
  private readonly controller = new AbortController();
  private retirement?: Promise<void>;
  private acquisition?: Promise<SidecarRunChild>;
  private child?: SidecarRunChild;
  private terminal = false;
  private notifyReadyFailure?: () => void;
  private stopReason = 'sidecar-cancelled';
  blocked = false;

  constructor(private readonly port: SidecarSpawnPort) {}

  checkCurrent() {
    if (this.controller.signal.aborted) throw new Error('OpenCode sidecar startup was cancelled');
  }

  async start(
    executable: string,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    startupMs: number,
    onTerminal: (detail: string) => void
  ): Promise<string> {
    this.checkCurrent();
    const signal = this.controller.signal;
    const deadline = Date.now() + startupMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () =>
      new Error(`OpenCode sidecar did not become ready within ${startupMs}ms`);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError());
        void this.stop('startup-timeout');
      }, startupMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      this.notifyReadyFailure = () => reject(new Error('OpenCode sidecar startup was cancelled'));
    });
    this.acquisition = Promise.resolve().then(() => {
      this.checkCurrent();
      if (Date.now() >= deadline) {
        void this.stop('startup-timeout');
        throw timeoutError();
      }
      return this.port.start(
        {
          executable,
          argv,
          cwd: process.cwd(),
          env,
          deadline,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        },
        signal
      );
    });
    try {
      const acquired = this.acquisition.catch(() => {
        throw new Error('OpenCode sidecar custody could not acquire a process');
      });
      this.child = await Promise.race([acquired, timeout, cancelled]);
      this.checkCurrent();
      const identity = this.child.spawn.catch(() => {
        throw new Error('OpenCode custody did not report a native identity');
      });
      const spawn = await Promise.race([identity, timeout, cancelled]);
      if (
        spawn.kind !== 'spawned' ||
        !Number.isSafeInteger(spawn.pid) ||
        spawn.pid <= 0 ||
        spawn.pid !== this.child.pid
      )
        throw new Error('OpenCode custody did not report a native identity');
      const terminal = new Promise<never>((_, reject) => {
        const finish = (detail: string) => {
          if (this.terminal || signal.aborted) return;
          this.terminal = true;
          reject(new Error(`OpenCode sidecar closed before readiness (${detail})`));
          onTerminal(detail);
        };
        void this.child!.exit.then(
          (fact) =>
            finish(
              fact.kind === 'exited'
                ? `native exit code ${Number.isSafeInteger(fact.code) ? fact.code : 'unknown'}`
                : 'native exit unobserved'
            ),
          () => finish('native exit unobserved')
        );
        void this.child!.close.then(
          (fact) =>
            finish(
              fact.kind === 'native-closed'
                ? 'native close'
                : fact.kind === 'transport-lost'
                  ? 'transport lost'
                  : 'native close unobserved'
            ),
          () => finish('native close unobserved')
        );
      });
      const url = await Promise.race([this.consumeStdout(), terminal, timeout, cancelled]);
      this.checkReady();
      if (Date.now() >= deadline) throw timeoutError();
      return url;
    } finally {
      clearTimeout(timer);
      this.notifyReadyFailure = undefined;
    }
  }

  checkReady() {
    this.checkCurrent();
    if (this.terminal) throw new Error('OpenCode sidecar exited immediately after startup');
  }

  stop(reason: string): Promise<void> {
    if (this.retirement) return this.retirement;
    this.stopReason = reason;
    const deadline = Date.now() + JOIN_MS;
    this.retirement = this.retire(deadline);
    this.controller.abort();
    this.notifyReadyFailure?.();
    return this.retirement;
  }

  private async retire(deadline: number) {
    if (!this.acquisition) return;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          expired = true;
          this.blocked = true;
          resolve();
        },
        Math.max(0, deadline - Date.now())
      );
    });
    const join = this.acquisition
      .then(
        async (child) => {
          const result = await child.stopAndJoin(this.stopReason, deadline);
          if (result.kind !== 'cleaned-owned') this.blocked = true;
        },
        (error: unknown) => {
          if (cleanupUncertain(error)) this.blocked = true;
        }
      )
      .catch(() => {
        this.blocked = true;
      });
    await Promise.race([join, limit]);
    clearTimeout(timer);
    if (expired) this.blocked = true;
  }

  private consumeStdout(): Promise<string> {
    const stdout = this.child?.stdout;
    const stderr = this.child?.stderr;
    const signal = this.controller.signal;
    const drain = async (reader?: Reader) => {
      while (reader && !signal.aborted && (await reader.read()).kind === 'bytes') {
        // Stderr does not contribute readiness or diagnostic text.
      }
    };
    void drain(stderr).catch(() => undefined);
    return new Promise<string>((resolve, reject) => {
      const read = async () => {
        const decoder = new TextDecoder();
        let output = '';
        let ready = false;
        while (stdout && !signal.aborted) {
          const item = await stdout.read();
          if (item.kind !== 'bytes') break;
          if (ready) continue;
          output = (output + decoder.decode(item.frame, { stream: true })).slice(-4096);
          const match = READY_LINE.exec(output);
          if (match?.[1]) {
            const address = new URL(match[1]);
            if (
              address.hostname !== '127.0.0.1' ||
              address.username ||
              address.password ||
              address.pathname !== '/' ||
              address.search ||
              address.hash
            )
              throw new Error('Unexpected OpenCode readiness URL');
            ready = true;
            resolve(address.origin);
          }
        }
        if (!ready) reject(new Error('OpenCode sidecar stdout ended before readiness'));
      };
      void read().catch(() => reject(new Error('OpenCode sidecar stdout could not be read')));
    });
  }
}
