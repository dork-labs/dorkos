import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { FrameQueue, encodeFrame } from './framing.mjs';
import { guardianFrame } from './guardian-schema.mjs';
import { recheckCustody } from './custody.mjs';

/** Native guardian adapter, inert until explicitly invoked; source acceptance is not execution release. */
export class NativeGuardianPort {
  constructor(custody, allocation, { acquire = spawn, now = () => performance.now() } = {}) {
    this.custody = custody;
    this.allocation = allocation;
    this.acquire = acquire;
    this.now = now;
    this.run = randomUUID();
    this.frames = new FrameQueue((value) => guardianFrame(value, this.allocation));
    this.events = [];
    this.child = null;
    this.spawnObserved = false;
    this.exitObserved = false;
    this.stdioClosed = false;
    this.outputFinalized = false;
    this.closed = false;
    this.started = false;
    this.executed = false;
    this.result = null;
    this.failure = null;
    this.outputEnd = new Promise((resolve) => {
      this.resolveOutputEnd = resolve;
    });
    this.stdioClose = new Promise((resolve) => {
      this.resolveStdioClose = resolve;
    });
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  async start() {
    if (this.started || this.closed) throw Error('GUARDIAN_START_REFUSED');
    this.started = true;
    const allocation = this.allocation;
    const custody = this.custody;
    const end = allocation.end;
    await recheckCustody(custody);
    if (this.closed) throw Error('GUARDIAN_START_REFUSED');
    // Parent slot and close/exit promises already exist before this fallible acquisition.
    const acquire = this.acquire;
    const path = custody.files.guardian.path;
    const args = [
      '--guardian',
      custody.root,
      custody.files['fixture-a'].sha256,
      custody.files['fixture-b'].sha256,
    ];
    const options = {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin' },
      shell: false,
    };
    const current = this.now();
    if (!Number.isFinite(current) || !Number.isFinite(end) || current >= end)
      throw Error('DEADLINE_EXCEEDED');
    // Method, argument and clock observations cannot replace the validated acquisition binding.
    if (
      this.closed ||
      this.failure ||
      this.child !== null ||
      this.allocation !== allocation ||
      this.custody !== custody
    )
      throw Error('GUARDIAN_START_REFUSED');
    this.child = Reflect.apply(acquire, this, [path, args, options]);
    this.child.once('exit', (code, signal) => {
      this.exitObserved = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.resolveExit();
    });
    this.child.once('close', () => {
      this.stdioClosed = true;
      this.resolveStdioClose();
    });
    this.child.once('error', () => {
      this.fail('GUARDIAN_ACQUISITION_UNVERIFIED');
      this.resolveExit();
    });
    this.child.stdout.on('data', (bytes) => {
      try {
        this.frames.push(bytes);
        let frame;
        while ((frame = this.frames.take())) {
          if (frame.cohort !== this.allocation.id || this.result || this.events.length >= 32)
            throw Error('GUARDIAN_SEQUENCE');
          if (frame.type === 'result') this.result = frame;
          else {
            if (frame.ordinal !== this.events.length + 1) throw Error('GUARDIAN_SEQUENCE');
            this.events.push(frame);
          }
          this.notify?.();
        }
      } catch {
        this.fail('GUARDIAN_PROTOCOL_UNVERIFIED');
      }
    });
    this.child.stdout.once('end', () => {
      try {
        this.frames.end();
        this.outputFinalized = true;
      } catch {
        this.fail('GUARDIAN_PROTOCOL_UNVERIFIED');
      }
      this.resolveOutputEnd();
      this.notify?.();
    });
    this.child.stdout.once('error', () => {
      this.fail('GUARDIAN_OUTPUT_UNVERIFIED');
      this.resolveOutputEnd();
    });
    this.child.stdout.once('close', () => {
      if (!this.outputFinalized) this.fail('GUARDIAN_OUTPUT_UNVERIFIED');
      this.resolveOutputEnd();
    });
    this.child.stdin.on('error', () => this.fail('GUARDIAN_CHANNEL_UNVERIFIED'));
    await new Promise((resolve, reject) => {
      this.child.once('spawn', () => {
        this.spawnObserved = true;
        resolve();
      });
      this.child.once('error', () => reject(Error('GUARDIAN_ACQUISITION_UNVERIFIED')));
    });
  }
  fail(code) {
    this.failure ??= code;
    this.child?.stdin.end();
    this.notify?.();
  }
  async exercise() {
    if (!this.spawnObserved || this.closed || this.executed) throw Error('GUARDIAN_RUN_REFUSED');
    this.executed = true;
    const allocation = this.allocation;
    const child = this.child;
    const stdin = child.stdin;
    const write = stdin.write;
    const phaseMs = Math.floor(allocation.end - this.now());
    if (!Number.isFinite(phaseMs) || phaseMs < 1) throw Error('DEADLINE_EXCEEDED');
    const frame = encodeFrame({
      type: 'run',
      run: this.run,
      cohort: this.allocation.id,
      phaseMs,
      signalAllowance: this.allocation.signals,
      custody: this.custody.binding,
    });
    if (
      this.closed ||
      this.failure ||
      this.exitObserved ||
      this.child !== child ||
      this.allocation !== allocation
    )
      throw Error('GUARDIAN_RUN_REFUSED');
    Reflect.apply(write, stdin, [frame]);
    await new Promise((resolve, reject) => {
      this.notify = () => {
        if (this.failure) reject(Error(this.failure));
        else if (this.result) resolve();
        else if (this.exitObserved) reject(Error('GUARDIAN_RESULT_UNAVAILABLE'));
      };
      this.exit.then(() => this.notify?.());
      this.notify();
    });
    const result = { ...this.result };
    delete result.type;
    delete result.slotsClosed;
    const counted = this.events.reduce(
      (counts, event) => {
        counts.signals++;
        if (event.type === 'attempt') {
          counts.deliveries += Number(event.delivery === true);
          counts.refusals += Number(event.refusal === true);
        } else counts.terminations += Number(event.observed === true);
        return counts;
      },
      { signals: 0, deliveries: 0, refusals: 0, terminations: 0 }
    );
    if (Object.keys(counted).some((key) => counted[key] !== result[key]))
      throw Error('GUARDIAN_COUNTS_UNVERIFIED');
    this.validated = true;
    return result;
  }
  async close({ end }) {
    this.closed = true;
    this.child?.stdin.end();
    let timer;
    try {
      await Promise.race([
        Promise.all([this.exit, this.outputEnd, this.stdioClose]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(0, end - this.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const channelsClosed =
      this.exitObserved && this.stdioClosed && this.outputFinalized && !this.failure;
    if (!channelsClosed) this.fail('GUARDIAN_CLOSE_UNVERIFIED');
    const observed =
      channelsClosed &&
      this.validated === true &&
      !this.failure &&
      this.result?.slotsClosed === true;
    return {
      guardianReaped: this.exitObserved,
      slotsClosed: observed,
      channelsClosed,
      custodyContinuous: observed,
      registeredExitComplete: observed,
    };
  }
}
