/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { McpAppFrameProps } from '@/layers/features/mcp-apps';
import type { DocMcpBinding } from '../model/doc-channel-view';
import type { useDocChannel } from '../model/use-doc-channel';
import { CanvasMcpAppContent } from '../ui/CanvasMcpAppContent';
const hooks = vi.hoisted(() => ({ channel: vi.fn(), session: vi.fn() }));
const frame = vi.hoisted((): { props?: McpAppFrameProps } => ({}));
vi.mock('../model/use-doc-channel', () => ({ useDocChannel: hooks.channel }));
vi.mock('@/layers/entities/session', () => ({ useSessionId: hooks.session }));
vi.mock('@/layers/features/mcp-apps', () => ({
  McpAppFrame: (props: McpAppFrameProps) => {
    frame.props = props;
    return <div data-testid="mcp-frame" />;
  },
}));
const documentId = 'actual-hosting-document';
const content = {
  type: 'mcp_app' as const,
  serverName: 'original-server',
  uri: 'ui://original-resource',
  title: 'Original App',
};
function projection(mcpBinding?: DocMcpBinding): ReturnType<typeof useDocChannel> {
  return {
    mcpBinding,
    events: [],
    replayObserved: true,
    channel: {
      documentId,
      enabled: false,
      destinationLabel: 'Log only',
      approvedEventTypes: [],
      submit: async () => {
        throw new Error('Widget routing is disabled');
      },
      inspect: async () => {
        throw new Error('Widget routing is disabled');
      },
    },
  };
}
function suppliedClosedBinding(): DocMcpBinding {
  return {
    documentId,
    owner: {},
    generation: 'original-native-birth',
    origin: {
      canonicalSessionId: 'original-resource-session',
      serverName: content.serverName,
      uri: content.uri,
      physicalRevision: 1,
      declaration: { routes: [] },
      declarationHash: 'a'.repeat(64),
    },
    current: vi.fn(() => true),
    captureOriginal: vi.fn(() => null),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  frame.props = undefined;
  hooks.session.mockReturnValue(['unrelated-active-ui-session', vi.fn()]);
});
afterEach(cleanup);
describe('Canvas MCP original hosting composition', () => {
  it('preserves active-session rendering without a Doc permission when original MCP origin is absent', () => {
    hooks.channel.mockReturnValue(projection());
    render(<CanvasMcpAppContent documentId={documentId} content={content} />);
    expect(screen.getByTestId('mcp-frame')).toBeDefined();
    expect(hooks.channel).toHaveBeenCalledWith(documentId);
    expect(frame.props?.sessionId).toBe('unrelated-active-ui-session');
    expect(frame.props?.serverName).toBe(content.serverName);
    expect(frame.props?.uri).toBe(content.uri);
    expect(frame.props?.docHost).toBeUndefined();
  });
  it('uses the original canonical resource session and delegates the supplied closed hook callbacks', () => {
    const binding = suppliedClosedBinding();
    hooks.channel.mockReturnValue(projection(binding));
    render(<CanvasMcpAppContent documentId={documentId} content={content} />);
    expect(frame.props?.sessionId).toBe(binding.origin.canonicalSessionId);
    const host = frame.props?.docHost;
    if (!host) throw new Error('Original hook hosting callbacks not composed');
    expect(host.documentId).toBe(documentId);
    expect(host.generation).toBe(binding.generation);
    expect(host.owner).toBe(binding.owner);
    expect(host.current()).toBe(true);
    const event = {
      v: 1 as const,
      id: '44444444-4444-4444-8444-444444444444',
      type: 'task.changed',
      payload: { value: 1 },
    };
    expect(host.captureOriginal(event)).toBeNull();
    expect(binding.captureOriginal).toHaveBeenCalledWith(event);
    vi.mocked(binding.current).mockReturnValue(false);
    expect(host.current()).toBe(false);
    expect(host.captureOriginal(event)).toBeNull();
    expect(binding.captureOriginal).toHaveBeenCalledTimes(1);
  });
  it.each([
    { serverName: 'other-server', uri: content.uri },
    { serverName: content.serverName, uri: 'ui://other-resource' },
  ])(
    'refuses a known original origin/content mismatch without render-only fallback ($serverName, $uri)',
    (value) => {
      hooks.channel.mockReturnValue(projection(suppliedClosedBinding()));
      render(<CanvasMcpAppContent documentId={documentId} content={{ ...content, ...value }} />);
      expect(screen.queryByTestId('mcp-frame')).toBeNull();
      expect(screen.getByText('This app is unavailable here.')).toBeDefined();
      expect(frame.props).toBeUndefined();
    }
  );
});
