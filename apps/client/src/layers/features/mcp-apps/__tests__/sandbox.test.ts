import { describe, it, expect } from 'vitest';
import {
  MCP_APP_SANDBOX,
  DEFAULT_MCP_APP_CSP,
  buildAllowAttribute,
  buildSandboxSrcDoc,
} from '../lib/sandbox';

describe('MCP App sandbox posture (spec mcp-apps-host §2.4)', () => {
  it('never grants allow-same-origin', () => {
    expect(MCP_APP_SANDBOX).toBe('allow-scripts');
    expect(MCP_APP_SANDBOX).not.toContain('allow-same-origin');
  });

  it('derives the allow attribute strictly from declared permissions', () => {
    expect(buildAllowAttribute([])).toBeUndefined();
    expect(buildAllowAttribute(['camera'])).toBe("camera 'self'");
    expect(buildAllowAttribute(['camera', 'microphone'])).toBe("camera 'self'; microphone 'self'");
  });

  it('injects the default CSP when the app declares none', () => {
    const doc = buildSandboxSrcDoc('<p>hi</p>', undefined);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain(DEFAULT_MCP_APP_CSP);
  });

  it('uses the app-declared CSP when present', () => {
    const csp = "default-src 'none'; img-src https://cdn.example";
    const doc = buildSandboxSrcDoc('<html><head></head><body></body></html>', csp);
    expect(doc).toContain(csp);
    expect(doc).not.toContain(DEFAULT_MCP_APP_CSP);
  });

  it('injects the CSP meta as the first head child of a full document', () => {
    const doc = buildSandboxSrcDoc(
      '<html><head><title>x</title></head><body></body></html>',
      undefined
    );
    const headIdx = doc.indexOf('<head>');
    const metaIdx = doc.indexOf('Content-Security-Policy');
    const titleIdx = doc.indexOf('<title>');
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeGreaterThan(headIdx);
    expect(metaIdx).toBeLessThan(titleIdx);
  });

  it('escapes quotes in the CSP so it cannot break out of the meta attribute', () => {
    const doc = buildSandboxSrcDoc('<p></p>', 'default-src "self"');
    expect(doc).not.toContain('content="default-src "self""');
    expect(doc).toContain('&quot;');
  });
});
