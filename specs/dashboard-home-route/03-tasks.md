# Task Breakdown: Dashboard Home Route

Generated: 2026-03-20
Source: specs/dashboard-home-route/02-specification.md
Last Decompose: 2026-03-20

## Overview

Introduce TanStack Router to the DorkOS client and restructure the app from a single-view SPA to a multi-view layout. The agent chat moves from `/` to `/session`, a new placeholder dashboard appears at `/`, and the nuqs dependency is removed entirely. Search params (`?session=`, `?dir=`) are replaced with TanStack Router's built-in `validateSearch` + `Route.useSearch()`.

## Phase 1: Foundation

### Task 1.1: Install TanStack Router dependencies and remove nuqs

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:

- Install `@tanstack/react-router` (^1.x) and `@tanstack/zod-adapter` (^1.x) as dependencies
- Install `@tanstack/react-router-devtools` (^1.x) as dev dependency
- Remove `nuqs` (^2.8.8) from dependencies
- Do NOT install `@tanstack/react-router-with-query` (SSR-only) or `@tanstack/router-vite-plugin` (file-based routing only)

**Implementation Steps**:

1. `pnpm add @tanstack/react-router @tanstack/zod-adapter` in `apps/client/`
2. `pnpm add -D @tanstack/react-router-devtools` in `apps/client/`
3. `pnpm remove nuqs` in `apps/client/`
4. `pnpm install` at monorepo root
5. `pnpm typecheck --filter=@dorkos/client` to verify

**Acceptance Criteria**:

- [ ] `@tanstack/react-router` and `@tanstack/zod-adapter` in `dependencies`
- [ ] `@tanstack/react-router-devtools` in `devDependencies`
- [ ] `nuqs` completely absent from `apps/client/package.json`
- [ ] Lockfile updated

---

### Task 1.2: Create router.ts with route tree and search param validation

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Create `apps/client/src/router.ts` at app level (not FSD layers)
- Route tree: root → `_shell` (pathless layout) → `/` (index) and `/session`
- `createRootRouteWithContext<RouterContext>()` with `QueryClient` context
- Pathless layout route (`id: '_shell'`) uses `AppShell` component
- Session route validates `?session=` and `?dir=` with Zod via `zodValidator`
- Index route has `beforeLoad` redirect for backward compat: `/?session=abc` → `/session?session=abc`
- `defaultPreload: 'intent'` for instant navigation on hover/focus
- TypeScript module augmentation registers the router type
- Exports `createAppRouter` factory and `SessionSearch` type

**Acceptance Criteria**:

- [ ] File exists at `apps/client/src/router.ts`
- [ ] Three routes: root, index (`/`), session (`/session`)
- [ ] Session route validates search params with Zod
- [ ] Index route redirects `/?session=x` to `/session?session=x`
- [ ] Module augmentation registers router type
- [ ] TypeScript compiles

---

### Task 1.3: Create useSessionSearch helper hook

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- New file: `apps/client/src/layers/entities/session/model/use-session-search.ts`
- Reads session route search params safely from any route
- Returns `Partial<SessionSearch>` — empty object when not on session route
- Uses try/catch around `useSearch({ from: '/session' })` as safe default
- Export from session entity barrel `index.ts`

**Acceptance Criteria**:

- [ ] Returns `{ session, dir }` on `/session?session=abc&dir=/path`
- [ ] Returns `{}` on `/` (no crash)
- [ ] Exported from `layers/entities/session/index.ts`
- [ ] Has TSDoc comment

---

### Task 1.4: Rewrite useSessionId from nuqs to TanStack Router

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.3
**Can run parallel with**: Task 1.5

**Technical Requirements**:

- Replace `useQueryState('session', { history: 'push' })` with `useSessionSearch()` + `useNavigate()`
- Public API unchanged: `[string | null, (id: string | null) => void]`
- Standalone setter navigates to `/session?session=<id>` (not just updating query param)
- Setting `null` passes `undefined` to omit `session` key from URL
- Embedded mode unchanged (Zustand store)

**Acceptance Criteria**:

- [ ] No `nuqs` import in `use-session-id.ts`
- [ ] Public API unchanged
- [ ] Standalone reads from TanStack Router search params
- [ ] Standalone setter calls `navigate({ to: '/session', search: ... })`
- [ ] Setting `null` removes session param
- [ ] Embedded mode unchanged
- [ ] TSDoc updated

---

### Task 1.5: Rewrite useDirectoryState from nuqs to TanStack Router

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.3
**Can run parallel with**: Task 1.4

**Technical Requirements**:

- Replace `useQueryState('dir')` with `useSessionSearch().dir` + `useNavigate()`
- Public API unchanged: `[string | null, (dir: string | null, opts?: SetDirOptions) => void]`
- Standalone setter uses `navigate({ search: ... })`
- URL → Zustand sync `useEffect` preserved
- `preserveSession` option preserved
- Fallback chain (`urlDir ?? storeDir`) preserved
- Embedded mode unchanged

**Acceptance Criteria**:

- [ ] No `nuqs` import in `use-directory-state.ts`
- [ ] Public API unchanged
- [ ] URL → Zustand sync effect preserved
- [ ] Setting `null` removes `?dir=` from URL
- [ ] `preserveSession: true` skips session clearing
- [ ] Embedded mode unchanged
- [ ] TSDoc updated

---

### Task 1.6: Extract AppShell from App.tsx for standalone mode

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- New file: `apps/client/src/AppShell.tsx`
- Contains standalone mode code from `App.tsx` lines 188-266
- Uses `<Outlet />` from `@tanstack/react-router` where `<ChatPanel>` was
- Full standalone shell: sidebar, header, onboarding gate, dialogs, toaster
- No `transformContent` prop (only used in embedded mode)
- `App.tsx` retains embedded mode branch only; returns `null` for standalone
- Clean up unused imports from `App.tsx` (SidebarProvider, DialogHost, OnboardingFlow, etc.)

**Acceptance Criteria**:

- [ ] `AppShell.tsx` exists and exports `AppShell`
- [ ] Uses `<Outlet />` for route content
- [ ] Contains full standalone shell
- [ ] `App.tsx` only contains embedded mode
- [ ] `App.tsx` has no standalone-only imports
- [ ] Both files have TSDoc comments

---

### Task 1.7: Update main.tsx to use RouterProvider instead of NuqsAdapter

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, Task 1.6
**Can run parallel with**: None

**Technical Requirements**:

- Remove `NuqsAdapter` import and wrapper
- Remove `App` import (standalone now uses router)
- Add `RouterProvider` from `@tanstack/react-router`
- Add `createAppRouter` from `./router`
- Create router inside `Root()`: `createAppRouter(queryClient)`
- Provider order: `QueryClientProvider` > `TransportProvider` > `RouterProvider`
- Dev playground rendering unchanged (before router)

**Acceptance Criteria**:

- [ ] No `nuqs` imports in `main.tsx`
- [ ] No `NuqsAdapter` wrapper
- [ ] `RouterProvider` renders the route tree
- [ ] Dev playground unchanged
- [ ] `TransportProvider` wraps `RouterProvider`
- [ ] `App` export still available for Obsidian plugin

---

## Phase 2: Pages & Navigation

### Task 2.1: Create DashboardPage placeholder widget

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Directory: `apps/client/src/layers/widgets/dashboard/`
- Centered heading "DorkOS" and subheading "Mission control for your agents"
- Uses design system Tailwind classes (`text-muted-foreground`, `tracking-tight`)
- Barrel `index.ts` with module-level TSDoc
- No data fetching (placeholder only)

**Acceptance Criteria**:

- [ ] `DashboardPage.tsx` renders centered heading and subheading
- [ ] Uses consistent design system classes
- [ ] Exported from barrel `index.ts`
- [ ] Renders at `/` route

---

### Task 2.2: Create SessionPage wrapper widget

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Directory: `apps/client/src/layers/widgets/session/`
- Thin wrapper: renders `<ChatPanel sessionId={activeSessionId} />`
- Uses `useSessionId()` for session ID from router search params
- No `transformContent` prop (embedded mode only)
- Barrel `index.ts` with module-level TSDoc

**Acceptance Criteria**:

- [ ] `SessionPage.tsx` renders `ChatPanel` with route-derived session ID
- [ ] No `transformContent` prop
- [ ] Exported from barrel `index.ts`
- [ ] Identical behavior to previous root view

---

### Task 2.3: Add Dashboard navigation to AgentSidebar and command palette

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, Task 1.4, Task 2.1
**Can run parallel with**: None

**Technical Requirements**:

- **AgentSidebar**: Add `Link` from TanStack Router, "Dashboard" nav link in sidebar header
- **Command palette actions**: Add `useNavigate` and `goToDashboard` case
- **Command palette items**: Add "Go to Dashboard" item with Home icon
- Existing "New session" button unchanged
- Session clicks still work via `useSessionId` setter

**Acceptance Criteria**:

- [ ] AgentSidebar has "Dashboard" link using `<Link to="/" />`
- [ ] Command palette has "Go to Dashboard" quick action
- [ ] Both use TanStack Router navigation (not `window.location`)
- [ ] Existing sidebar behavior unchanged
- [ ] Session clicks still navigate to `/session`

---

### Task 2.4: Verify all consumer components work without changes

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.4, Task 1.5, Task 1.6, Task 1.7, Task 2.1, Task 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Verify 10 consumer components need zero code changes
- Run `pnpm typecheck --filter=@dorkos/client`
- Run `pnpm test --filter=@dorkos/client -- --run`
- Grep for remaining `nuqs` imports (should be zero)

**Acceptance Criteria**:

- [ ] Zero consumer-level code changes needed
- [ ] `pnpm typecheck` passes
- [ ] No `nuqs` imports remain in `apps/client/src/`
- [ ] All existing hook-level mock tests pass unchanged

---

## Phase 3: Testing & Cleanup

### Task 3.1: Update use-directory-state.test.tsx to mock TanStack Router instead of nuqs

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Replace `vi.mock('nuqs', ...)` with mocks for `useSessionSearch` and `useNavigate`
- `mockUrlDir` → `mockSearchDir` (via `useSessionSearch` return)
- `mockSetUrlDir` → `mockNavigate` (via `useNavigate` return)
- All 8 test cases preserved with equivalent assertions
- Assertions verify `mockNavigate({ search: expect.any(Function) })` instead of `mockSetUrlDir()`

**Acceptance Criteria**:

- [ ] No `nuqs` mock in test file
- [ ] Mocks `useSessionSearch` and `useNavigate`
- [ ] All 8 test cases pass
- [ ] Coverage equivalent to original

---

### Task 3.2: Create routing integration test suite

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, Task 2.1, Task 2.2
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- New file: `apps/client/src/__tests__/routing.test.tsx`
- Uses `@vitest-environment jsdom`
- Mocks `DashboardPage`, `SessionPage`, `AppShell` to isolate routing
- Tests: DashboardPage at `/`, SessionPage at `/session`, 404 for unknown routes
- Uses `createAppRouter` with `createMemoryHistory`

**Acceptance Criteria**:

- [ ] Tests verify DashboardPage renders at `/`
- [ ] Tests verify SessionPage renders at `/session`
- [ ] Tests verify 404 for unknown routes
- [ ] All tests pass with `pnpm vitest run`

---

### Task 3.3: Update E2E tests and ChatPage POM to use /session route

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.7
**Can run parallel with**: Task 3.1, Task 3.2

**Technical Requirements**:

- Update `ChatPage.goto()` in `apps/e2e/pages/ChatPage.ts`: `/?session=` → `/session?session=`
- Update all raw `page.goto('/')` calls expecting chat UI to `/session`
- Verify with grep: `goto('/')` and `goto("/")` in `apps/e2e/`

**Acceptance Criteria**:

- [ ] `ChatPage.goto()` navigates to `/session`
- [ ] All E2E chat tests use `/session` route
- [ ] Deep link format is `/session?session=abc&dir=/path`
- [ ] E2E tests pass

---

### Task 3.4: Remove all remaining nuqs references and verify clean codebase

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.4, Task 1.5, Task 1.7, Task 3.1
**Can run parallel with**: Task 3.5

**Technical Requirements**:

- Grep entire codebase for `nuqs`, `NuqsAdapter`, `useQueryState` — zero results
- Verify lockfile is clean
- Run full suite: `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`

**Acceptance Criteria**:

- [ ] Zero nuqs references in codebase
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test -- --run` passes

---

### Task 3.5: Update documentation to reflect routing changes

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.4
**Can run parallel with**: Task 3.4

**Technical Requirements**:

- `AGENTS.md`: Replace nuqs reference with TanStack Router, document route structure
- `contributing/architecture.md`: Add client routing section with route table
- `contributing/state-management.md`: Replace nuqs references with TanStack Router search params
- `contributing/project-structure.md`: Document `router.ts`, `AppShell.tsx`, new widget directories

**Acceptance Criteria**:

- [ ] `AGENTS.md` references TanStack Router (not nuqs)
- [ ] `contributing/architecture.md` has routing section
- [ ] `contributing/state-management.md` updated
- [ ] `contributing/project-structure.md` lists new files
- [ ] No nuqs mentions in contributing docs
