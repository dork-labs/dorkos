---
paths: "**/__tests__/**/*.ts", "**/__tests__/**/*.tsx", "**/*.test.ts", "**/*.test.tsx"
---

# Testing Rules

These rules apply to all test files in the `__tests__/` directory.

## Test File Structure

Tests mirror the source structure under `__tests__/`:

```
__tests__/
├── layers/
│   ├── widgets/
│   │   └── [widget-name]/ui/*.test.tsx
│   ├── features/
│   │   └── [feature-name]/
│   │       ├── ui/*.test.tsx
│   │       └── model/*.test.ts
│   └── entities/
│       └── [entity-name]/
│           ├── api/*.test.ts
│           └── model/*.test.ts
└── lib/*.test.ts
```

## Required Patterns

### Environment Directive

Component tests need jsdom environment:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
```

### Mock Next.js APIs

Always mock Next.js navigation and request APIs:

```typescript
// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/'),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}))
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
  })
})
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

### DAL Function Tests

```typescript
describe('getUserById', () => {
  it('returns user when found', async () => {
    // Mock Prisma
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser)

    const result = await getUserById('123')
    expect(result).toEqual(mockUser)
  })

  it('throws UnauthorizedError when access denied', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    await expect(getUserById('123')).rejects.toThrow(UnauthorizedError)
  })
})
```

### Hook Tests

```typescript
import { renderHook, waitFor } from '@testing-library/react'

describe('useCustomHook', () => {
  it('returns expected state', async () => {
    const { result } = renderHook(() => useCustomHook(), {
      wrapper: Wrapper,
    })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
  })
})
```

## Naming Conventions

| Pattern | Example |
|---------|---------|
| Describe block | Component/function name |
| Test case | `it('does specific behavior', ...)` |
| Mock files | `__mocks__/moduleName.ts` |

## Anti-Patterns (Never Do)

```typescript
// NEVER test implementation details
expect(component.state.isOpen).toBe(true)  // Wrong - test behavior

// NEVER use waitFor without assertion
await waitFor(() => {})  // Wrong

// NEVER leave console mocks without cleanup
vi.spyOn(console, 'error')  // Add mockRestore in afterEach

// NEVER use arbitrary timeouts
await new Promise(r => setTimeout(r, 1000))  // Wrong - use waitFor
```

## Running Tests

```bash
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # With coverage report
```
