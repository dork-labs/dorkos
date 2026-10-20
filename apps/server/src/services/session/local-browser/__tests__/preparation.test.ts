import { describe, expect, it, vi } from 'vitest';
import { BrowserDownloadProgress, BrowserPreparation } from '../preparation.js';

describe('managed-browser preparation', () => {
  it('reads genuine component percentages across chunks without publishing installer details', () => {
    const report = vi.fn();
    const progress = new BrowserDownloadProgress(report);
    progress.push(
      'Downloading Chrome for Testing 153 (playwright chromium v1) from https://private/token\n|■■'
    );
    progress.push('  |  20% of 100 MiB\ninstaller diagnostic 99% https://private/token\n');
    progress.push(
      'Downloading FFmpeg (playwright ffmpeg v1) from https://private/token\r|■■|  80% of 2 MiB\n'
    );
    progress.push(
      'Downloading Chrome Headless Shell 153 from https://private/token\n|■■|  100% of 50 MiB\n'
    );
    expect(report.mock.calls.map(([state]) => state)).toEqual([
      { stage: 'downloading', component: 'chromium', percent: null },
      { stage: 'downloading', component: 'chromium', percent: 20 },
      { stage: 'downloading', component: 'ffmpeg', percent: null },
      { stage: 'downloading', component: 'ffmpeg', percent: 80 },
      { stage: 'downloading', component: 'headless-shell', percent: null },
      { stage: 'downloading', component: 'headless-shell', percent: 100 },
    ]);
    expect(JSON.stringify(report.mock.calls)).not.toContain('private');
  });
  it('keeps unknown downloads indeterminate and ignores invented or invalid percentages', () => {
    const report = vi.fn();
    const progress = new BrowserDownloadProgress(report);
    progress.push('Downloading Unknown Package from https://private/token\n|■■|  60% of 20 MiB\n');
    progress.push(
      'Downloading Chromium from https://private/token\n|■■|  101% of 20 MiB\n25% guessed\n'
    );
    expect(report.mock.calls.map(([state]) => state)).toEqual([
      { stage: 'downloading', component: null, percent: null },
      { stage: 'downloading', component: 'chromium', percent: null },
    ]);
  });
  it('fences late callbacks after cancellation and replacement openings', () => {
    const preparation = new BrowserPreparation();
    const first = preparation.start();
    first({ stage: 'downloading', component: 'chromium', percent: 30 });
    expect(preparation.current?.percent).toBe(30);
    preparation.clear();
    first({ stage: 'downloading', component: 'chromium', percent: 40 });
    expect(preparation.current).toBeNull();
    const second = preparation.start();
    first({ stage: 'downloading', component: 'chromium', percent: 80 });
    expect(preparation.current).toEqual({ stage: 'checking', component: null, percent: null });
    second({ stage: 'launching', component: null, percent: null });
    expect(preparation.current?.stage).toBe('launching');
  });
});
