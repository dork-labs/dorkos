/**
 * Forward an isolated extension's standard output and error to DorkOS's log,
 * with a rate cap (DOR-2686, spec §4 and §9).
 *
 * Each stream is split into lines; every line is shown as `[ext:<id>] <line>`
 * (output at `info`, errors at `warn`). At most 200 lines are written per
 * 10 seconds, across both streams; when the cap trips, one "output suppressed"
 * line is written and the rest of that window is dropped. A line longer than
 * 4,000 characters is cut. A chatty or hostile child can therefore never flood
 * the log.
 *
 * Every line is also offered to `onLine` before the cap applies, so the host
 * still sees V8's out-of-memory marker when the log is suppressed.
 *
 * @module services/extensions/isolation/log-forwarder
 */
import type { Readable } from 'node:stream';
import { ISOLATION_LIMITS } from './ipc-protocol.js';

/** Where forwarded lines go. */
export interface ForwardLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** How to forward one child's output. */
export interface LogForwarderOptions {
  /** The extension id, shown as `[ext:<id>]`. */
  extensionId: string;
  /** The log. */
  logger: ForwardLogger;
  /** Sees every line, from either stream, before the cap. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Lines per window (default 200). */
  linesPerWindow?: number;
  /** The window, in milliseconds (default 10 s). */
  windowMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/**
 * Forward lines from a child's streams to the log, capped per window.
 */
export class LogForwarder {
  private windowStart = 0;
  private count = 0;
  private suppressed = false;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly prefix: string;

  /**
   * Prepare a forwarder for one child.
   *
   * @param options - The extension, the log, and the cap.
   */
  constructor(private readonly options: LogForwarderOptions) {
    this.limit = options.linesPerWindow ?? ISOLATION_LIMITS.logLinesPerWindow;
    this.windowMs = options.windowMs ?? ISOLATION_LIMITS.logWindowMs;
    this.now = options.now ?? Date.now;
    this.prefix = `[ext:${options.extensionId}]`;
  }

  /**
   * Follow one stream until it ends.
   *
   * @param stream - The child's stdout or stderr.
   * @param kind - Which one it is.
   */
  attach(stream: Readable | null, kind: 'stdout' | 'stderr'): void {
    if (!stream) return;
    stream.setEncoding('utf8');
    let pending = '';
    stream.on('data', (chunk: string) => {
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index !== -1) {
        this.line(pending.slice(0, index).replace(/\r$/, ''), kind);
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
      // A line with no end in sight is cut rather than buffered forever.
      if (pending.length > ISOLATION_LIMITS.logLineMaxChars) {
        this.line(pending, kind);
        pending = '';
      }
    });
    stream.on('end', () => {
      if (pending.length > 0) this.line(pending, kind);
      pending = '';
    });
  }

  /**
   * Handle one line: offer it to `onLine`, then write it if the cap allows.
   *
   * @param raw - The line, without its newline.
   * @param kind - The stream it came from.
   */
  line(raw: string, kind: 'stdout' | 'stderr'): void {
    const text =
      raw.length > ISOLATION_LIMITS.logLineMaxChars
        ? `${raw.slice(0, ISOLATION_LIMITS.logLineMaxChars)}…`
        : raw;
    this.options.onLine?.(text, kind);
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
      this.suppressed = false;
    }
    if (this.count >= this.limit) {
      if (!this.suppressed) {
        this.suppressed = true;
        this.options.logger.warn(`${this.prefix} output suppressed`);
      }
      return;
    }
    this.count++;
    if (kind === 'stdout') this.options.logger.info(`${this.prefix} ${text}`);
    else this.options.logger.warn(`${this.prefix} ${text}`);
  }
}
