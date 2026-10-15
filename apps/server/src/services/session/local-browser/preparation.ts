import type { LocalBrowserPreparation } from '@dorkos/shared/local-browser';

/** Downloader events contain only known components and reported percentages. */
export type BrowserPreparationListener = (state: LocalBrowserPreparation) => void;

/** Opening-generation fence for acquisition callbacks, reset on completion or cancellation. */
export class BrowserPreparation {
  private generation = 0;
  current: LocalBrowserPreparation | null = null;

  /** Start a new preparation generation and return its fenced progress callback. */
  start(): BrowserPreparationListener {
    const generation = ++this.generation;
    this.current = { stage: 'checking', component: null, percent: null };
    return (state) => {
      if (generation === this.generation) this.current = { ...state };
    };
  }

  /** Clear state and reject callbacks from every older opening generation. */
  clear(): void {
    this.generation += 1;
    this.current = null;
  }
}

/** Parse bounded installer stdout without exposing its URLs, paths, or error text. */
export class BrowserDownloadProgress {
  private buffer = '';
  private component: LocalBrowserPreparation['component'] = null;

  constructor(private readonly report: BrowserPreparationListener) {}

  /** Consume chunks, retaining at most one bounded partial line. */
  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/[\r\n]/);
    this.buffer = (lines.pop() ?? '').slice(-8192);
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (line.startsWith('Downloading ')) {
      if (/headless.*shell/i.test(line)) this.component = 'headless-shell';
      else if (/ffmpeg/i.test(line)) this.component = 'ffmpeg';
      else if (/chromium|chrome for testing/i.test(line)) this.component = 'chromium';
      else this.component = null;
      this.report({ stage: 'downloading', component: this.component, percent: null });
      return;
    }
    const match = /^\|[^|]*\|\s+(\d{1,3})% of /u.exec(line);
    if (!match || !this.component) return;
    const percent = Number(match[1]);
    if (percent <= 100) this.report({ stage: 'downloading', component: this.component, percent });
  }
}
