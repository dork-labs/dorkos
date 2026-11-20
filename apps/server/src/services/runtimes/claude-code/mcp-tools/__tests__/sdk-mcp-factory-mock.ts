import { vi } from 'vitest';

/**
 * Record hand definitions and subsequent full-schema registrations without
 * opening a transport. SDK evaluation stays inside its owning adapter.
 */
export async function sdkMcpFactoryMock(): Promise<Record<string, unknown>> {
  const sdk = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk'
  );
  return {
    ...sdk,
    createSdkMcpServer: vi.fn((config: Parameters<typeof sdk.createSdkMcpServer>[0]) => {
      const tools: unknown[] = [...(config.tools ?? [])];
      return {
        ...config,
        tools,
        instance: {
          registerTool: vi.fn(
            (name: string, options: Record<string, unknown>, handler: unknown) => {
              tools.push({ name, ...options, handler });
            }
          ),
          registerResource: vi.fn(),
          server: { registerCapabilities: vi.fn() },
        },
      };
    }),
  };
}
