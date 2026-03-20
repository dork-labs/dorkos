---
paths: "**/__tests__/**/*.ts", "**/__tests__/**/*.tsx", "**/*.test.ts", "**/*.test.tsx"
---

# Testing Rules

These rules apply to all test files in the `__tests__/` directory.

## Test File Structure

Tests live alongside source in `__tests__/` directories within each app:

```
apps/server/src/
├── services/
│   └── __tests__/
│       ├── transcript-reader.test.ts
│       ├── agent-manager.test.ts
│       └── session-broadcaster.test.ts
apps/client/src/
├── components/
│   └── __tests__/
│       ├── MessageList.test.tsx
│       └── SessionSidebar.test.tsx
├── hooks/
│   └── __tests__/
│       └── use-chat-session.test.ts
```

## Required Patterns

### Environment Directive

Component tests need jsdom environment:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
```

### Mock Transport (Required for Client Components)

Components use the Transport interface via React Context. Always provide a mock Transport in tests:

```typescript
import { TransportProvider } from '@/contexts/TransportContext'
import { createMockTransport } from '@dorkos/test-utils'

const mockTransport = createMockTransport()

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <TransportProvider transport={mockTransport}>
      {children}
    </TransportProvider>
  )
}
```

### Mock Browser APIs

When testing components that use browser APIs:

```typescript
beforeAll(() => {
  // Mock matchMedia for responsive components
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
```

### Wrapper Components

Wrap components that need context providers:

```typescript
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        {children}
      </SidebarProvider>
    </QueryClientProvider>
  )
}

render(<MyComponent />, { wrapper: Wrapper })
```

## Test Types

### Component Tests (UI)

```typescript
describe('ComponentName', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders expected content', () => {
    render(<Component />)
    expect(screen.getByText('Expected')).toBeInTheDocument()
  })

  it('handles user interaction', async () => {
    const user = userEvent.setup()
    render(<Component />)

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Updated')).toBeInTheDocument()
  })
})
```

### Service Tests

```typescript
describe('TranscriptReader', () => {
  it('returns session when found', async () => {
    // Mock fs/promises for transcript reading
    vi.mocked(readFile).mockResolvedValue(Buffer.from(mockJsonl));

    const result = await transcriptReader.getSession('test-id');
    expect(result).toEqual(expect.objectContaining({ id: 'test-id' }));
  });

  it('throws when session not found', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    await expect(transcriptReader.getSession('missing')).rejects.toThrow();
  });
});
```

### Hook Tests

```typescript
import { renderHook, waitFor } from '@testing-library/react';

describe('useCustomHook', () => {
  it('returns expected state', async () => {
    const { result } = renderHook(() => useCustomHook(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
  });
});
```

## Naming Conventions

| Pattern        | Example                             |
| -------------- | ----------------------------------- |
| Describe block | Component/function name             |
| Test case      | `it('does specific behavior', ...)` |
| Mock files     | `__mocks__/moduleName.ts`           |

## Anti-Patterns (Never Do)

```typescript
// NEVER test implementation details
expect(component.state.isOpen).toBe(true); // Wrong - test behavior

// NEVER use waitFor without assertion
await waitFor(() => {}); // Wrong

// NEVER leave console mocks without cleanup
vi.spyOn(console, 'error'); // Add mockRestore in afterEach

// NEVER use arbitrary timeouts
await new Promise((r) => setTimeout(r, 1000)); // Wrong - use waitFor
```

## Mock AgentRuntime (Server Tests)

Server route tests that touch session endpoints need a mock `AgentRuntime`. Use `FakeAgentRuntime` from `@dorkos/test-utils` instead of hand-rolling a mock object:

```typescript
import { FakeAgentRuntime, TestScenario } from '@dorkos/test-utils';

let fakeRuntime: FakeAgentRuntime;

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.mocked(runtimeRegistry.getDefault).mockReturnValue(fakeRuntime);
});
```

Load scenarios to control what `sendMessage()` yields:

```typescript
import { testScenarios } from '@dorkos/test-utils';

fakeRuntime.withScenarios([testScenarios[TestScenario.SimpleText]('Hello')]);
```

`FakeAgentRuntime` implements every method on the `AgentRuntime` interface with `vi.fn()` spies. If the interface adds a method, tests using `FakeAgentRuntime` will fail to compile — this is intentional.

### SDK-Level Scenarios (Tier 1)

For tests that operate at the `SDKMessage` level (e.g., `claude-code-runtime.test.ts`), use the shared scenario builders in `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts`:

```typescript
import { wrapSdkQuery, sdkSimpleText, sdkToolCall } from './sdk-scenarios.js';

const queryResult = wrapSdkQuery(sdkSimpleText('Echo: Hello'));
```

These builders live inside the ESLint boundary for `@anthropic-ai/claude-agent-sdk` imports. Do not import them from outside `services/runtimes/claude-code/`.

### SSE Integration Tests

Use `collectSseEvents` from `@dorkos/test-utils` to test SSE streaming end-to-end with supertest:

```typescript
import { collectSseEvents } from '@dorkos/test-utils';

const events = await collectSseEvents(app, sessionId, 'Hello');
expect(events.some((e) => e.type === 'text_delta')).toBe(true);
```

## Running Tests

```bash
pnpm test                         # Run all tests via Turborepo
pnpm test -- --run                # Single run (no watch)
pnpm vitest run path/to/test.ts   # Run a specific test file
pnpm vitest --watch               # Watch mode
```
