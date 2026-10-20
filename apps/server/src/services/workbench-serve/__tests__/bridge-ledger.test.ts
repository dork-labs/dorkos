import { describe, it, expect } from 'vitest';
import { FrameBridgeLedger, bridgeTargetForUrl, previewPageKey } from '../bridge-ledger.js';

describe('FrameBridgeLedger', () => {
  it('answers the newest decision per page, and unknown for one it never saw', () => {
    const ledger = new FrameBridgeLedger();
    ledger.record('file:/a.html', 'csp');
    ledger.record('file:/a.html', null);
    expect(ledger.status('file:/a.html')).toEqual({ bridge: 'added' });
    expect(ledger.status('file:/b.html')).toEqual({ bridge: 'unknown' });
    expect(ledger.status(null)).toEqual({ bridge: 'unknown' });
  });

  it('keeps no key a page could use to pin memory', () => {
    const ledger = new FrameBridgeLedger();
    const long = previewPageKey(5173, `/${'a'.repeat(4096)}`);
    ledger.record(long, 'markup');
    expect(ledger.status(long)).toEqual({ bridge: 'unknown' });
  });

  it('forgets the oldest page past its bound', () => {
    const ledger = new FrameBridgeLedger();
    for (let n = 0; n <= 512; n++) ledger.record(`file:/${n}.html`, null);
    expect(ledger.status('file:/0.html')).toEqual({ bridge: 'unknown' });
    expect(ledger.status('file:/512.html')).toEqual({ bridge: 'added' });
  });
});

describe('naming a page the way the serving paths do', () => {
  it('treats encoding and the query as the same page, and never reads `//` as a host', () => {
    expect(previewPageKey(3000, '/a b?x=1')).toBe(previewPageKey(3000, '/a%20b'));
    expect(previewPageKey(3000, '//evil.example/x')).toBe('preview:3000://evil.example/x');
  });

  it('classifies a document URL as the canvas frames it', () => {
    expect(bridgeTargetForUrl('http://localhost:5173/app?x=1', null)).toEqual({
      kind: 'proxy',
      port: 5173,
      path: '/app?x=1',
    });
    expect(bridgeTargetForUrl('demo/index.html', '/work')).toEqual({
      kind: 'serve',
      cwd: '/work',
      path: 'demo/index.html',
    });
    expect(bridgeTargetForUrl('demo/index.html', null)).toBeNull();
    expect(bridgeTargetForUrl('https://example.com/', '/work')).toBeNull();
  });
});
