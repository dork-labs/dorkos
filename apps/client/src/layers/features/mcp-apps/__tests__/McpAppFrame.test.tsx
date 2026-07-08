/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { McpAppResourceResponse } from '@dorkos/shared/schemas';
import { McpAppFrame } from '../ui/McpAppFrame';

function renderFrame(resource: McpAppResourceResponse) {
  const transport = createMockTransport();
  transport.fetchMcpAppResource = vi.fn().mockResolvedValue(resource);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <McpAppFrame sessionId="s1" serverName="fixture-app" uri="ui://dash/main" />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, ...utils };
}

describe('McpAppFrame sandbox attributes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a strict-sandbox iframe (allow-scripts, never allow-same-origin)', async () => {
    const { container } = renderFrame({
      mimeType: 'text/html',
      text: '<html><head></head><body>hi</body></html>',
      permissions: [],
    });

    const iframe = await waitFor(() => {
      const el = container.querySelector('iframe');
      expect(el).not.toBeNull();
      return el as HTMLIFrameElement;
    });
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    // No permissions declared → no allow attribute at all.
    expect(iframe.hasAttribute('allow')).toBe(false);
    // CSP is injected into the srcdoc.
    expect(iframe.getAttribute('srcdoc')).toContain('Content-Security-Policy');
  });

  it('sets the allow attribute strictly from declared permissions', async () => {
    const { container } = renderFrame({
      mimeType: 'text/html;profile=mcp-app',
      text: '<html><head></head><body></body></html>',
      permissions: ['camera', 'clipboard-write'],
    });

    const iframe = await waitFor(() => {
      const el = container.querySelector('iframe');
      expect(el).not.toBeNull();
      return el as HTMLIFrameElement;
    });
    expect(iframe.getAttribute('allow')).toBe("camera 'self'; clipboard-write 'self'");
  });
});
