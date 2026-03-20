---
title: 'Filesystem Agent Discovery: Progressive vs Batch, Transport Abstraction, and Unification Patterns'
date: 2026-03-06
type: internal-architecture
status: active
tags: [discovery, scanning, sse, transport, onboarding, mesh, ux]
feature_slug: mesh-topology-elevation
searches_performed: 7
sources_count: 18
---

# Filesystem Agent Discovery: Unification Patterns

**Research Date:** 2026-03-06
**Research Mode:** Focused Investigation
**Searches Performed:** 7 web searches + 1 existing research file

---

## Research Summary

The two discovery systems (SSE-streamed onboarding scan and batch mesh panel scan) should be unified behind a single canonical scanner (the existing `scanForAgents` async generator) with two consumption modes. Progressive streaming is correct for first-time discovery and any scan over unknown directories; batch is appropriate only when re-scanning previously configured roots. The transport abstraction should expose the async generator directly for in-process use (DirectTransport) and wrap it in SSE for HTTP, with the React layer consuming both via TanStack Query mutations that accept an `onData` callback. Default scan roots should use smart detection of common developer directories rather than blindly scanning `$HOME`.

---

## Key Findings

### 1. Progressive vs Batch: When to Use Each

**Progressive streaming is almost always correct for filesystem scans.** The core insight from VS Code's Project Manager extension ecosystem and JetBrains Toolbox is that project discovery is inherently unpredictable in duration -- scanning `$HOME` could take 2 seconds or 30 seconds depending on directory depth and disk speed.

**Use progressive (streaming) when:**

- First-time scan (onboarding) -- user has no expectation of how many results exist
- Scanning a new/unconfigured root directory
- Any scan that could exceed ~2 seconds
- The UI benefits from showing results as they appear (which is always)

**Use batch (wait-for-all) only when:**

- Re-scanning a known, small set of previously cached roots (< 1 second expected)
- Background refresh where the UI already has stale-but-present data

**The recommendation:** Always stream. The batch case is just "stream but don't show a progress indicator because the data arrives fast enough." The scanner is the same; the UI presentation differs.

**Prior art:**

- **VS Code Git Project Manager** caches repositories between sessions (`storeRepositoriesBetweenSessions`) to avoid wait time, but still scans progressively on first use. Subsequent opens show cached data instantly with a background refresh.
- **JetBrains Toolbox** detects projects from IDE config directories (`.idea/`) and shows them immediately. The project list "is now updated more often, and more efficiently too, meaning it always stays up to date while consuming fewer resources."
- **Chrome DevTools Automatic Workspace Folders** lets devservers inform DevTools about project folders, which DevTools picks up automatically -- zero-scan, push-based discovery.

### 2. Default Scan Root Selection

**Do not scan `$HOME` by default.** It is too broad and includes Library/, .cache/, .npm/, and hundreds of irrelevant directories. Instead, use smart detection:

**Recommended approach: Probe common developer directories, then fall back to asking.**

```typescript
const COMMON_DEV_DIRS = [
  '~/Developer', // macOS special folder (gets custom icon)
  '~/Projects',
  '~/projects',
  '~/dev',
  '~/code',
  '~/src',
  '~/repos',
  '~/workspace',
  '~/Work',
  '~/work',
  '~/GitHub',
  '~/github',
];
```

**Algorithm:**

1. Check which of `COMMON_DEV_DIRS` exist (parallel `stat()` calls -- fast)
2. If exactly one exists, use it as default
3. If multiple exist, show them as suggestions and let the user pick
4. If none exist, ask the user to specify (with `$HOME` as the escape hatch)
5. After first scan, persist the chosen roots in config (`mesh.scanRoots`)

**Prior art:**

- **VS Code Project Manager** uses `projectManager.git.baseFolders` -- an explicit list of folders or glob patterns. No auto-detection; user configures.
- **Git Project Manager** uses `gitProjectManager.baseProjectsFolders` with `maxDepthRecursion: 2` (default). User must configure base folders.
- macOS gives `~/Developer` a special Xcode folder icon, signaling it as the canonical dev directory.

### 3. Transport Abstraction for Streaming Discovery

The existing `scanForAgents` async generator is already transport-agnostic. The unification pattern:

**Server side (HTTP transport):**

```typescript
// Single route handler for both onboarding and mesh panel
app.post('/api/discovery/scan', async (req, res) => {
  initSSEStream(res);
  for await (const event of scanForAgents(options)) {
    sendSSEEvent(res, event.type, event.data);
  }
  endSSEStream(res);
});
```

**In-process (DirectTransport for Obsidian):**

```typescript
class DirectTransport implements Transport {
  async *scanForAgents(options: ScanOptions): AsyncGenerator<ScanEvent> {
    yield* scanForAgents(options);
  }
}
```

**React consumption pattern -- single hook for both transports:**

```typescript
function useDiscoveryScan() {
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  const scan = useCallback(
    async (options: ScanOptions) => {
      setIsScanning(true);
      setCandidates([]);

      // transport.scan() returns AsyncIterable<ScanEvent> in both modes
      for await (const event of transport.scan(options)) {
        if (event.type === 'candidate') {
          setCandidates((prev) => [...prev, event.data]);
        } else if (event.type === 'progress') {
          setProgress(event.data);
        } else if (event.type === 'complete') {
          setProgress(event.data);
        }
      }
      setIsScanning(false);
    },
    [transport]
  );

  return { candidates, progress, isScanning, scan };
}
```

**Key insight from the React streaming ecosystem:** Buffer incoming events using `requestAnimationFrame` batching when scan results arrive faster than the render cycle. The pattern from [SitePoint's streaming backends article](https://www.sitepoint.com/streaming-backends-react-controlling-re-render-chaos/) recommends:

```typescript
// Buffer rapid events, flush once per frame
const bufferRef = useRef<DiscoveryCandidate[]>([]);
const rafRef = useRef<number>();

function onCandidate(candidate: DiscoveryCandidate) {
  bufferRef.current.push(candidate);
  if (!rafRef.current) {
    rafRef.current = requestAnimationFrame(() => {
      setCandidates((prev) => [...prev, ...bufferRef.current]);
      bufferRef.current = [];
      rafRef.current = undefined;
    });
  }
}
```

### 4. Deduplication: One Scanner, Multiple Presentations

**The canonical architecture:**

```
┌──────────────────────────────────────────────┐
│           scanForAgents() (async generator)   │  ← Single scanner
│           services/discovery/discovery-scanner │
└──────────────┬───────────────────────────────┘
               │
        ┌──────┴──────┐
        │ Transport   │  ← SSE or in-process
        └──────┬──────┘
               │
     ┌─────────┴─────────┐
     │  useDiscoveryScan  │  ← Single hook
     └─────────┬──────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
┌───┴───┐ ┌───┴───┐ ┌───┴───┐
│Onboard│ │ Mesh  │ │ Cmd+K │  ← Multiple UI consumers
│  Flow │ │ Panel │ │Palette│
└───────┘ └───────┘ └───────┘
```

**Pattern: Lift scan state to a shared store (Zustand or context).**

The onboarding flow and mesh panel should not each own their own scan state. Instead:

```typescript
// Shared scan store
interface DiscoveryStore {
  candidates: DiscoveryCandidate[];
  progress: ScanProgress | null;
  isScanning: boolean;
  lastScanAt: number | null;
  scan: (options: ScanOptions) => Promise<void>;
  clear: () => void;
}
```

Both the onboarding step and the mesh panel read from the same store. If the user scans during onboarding, the mesh panel already has the results when they navigate to it. No duplicate scan needed.

**Cache strategy:**

- Cache scan results in the store with a `lastScanAt` timestamp
- Show cached results immediately on mount
- Offer "Re-scan" button that clears and re-runs
- Background re-scan on a long interval (5 minutes) if the panel is open

### 5. Scan Root Configuration UX

**Three-tier approach: auto-detect, then suggest, then configure.**

**Tier 1 -- Zero-config (first run):**

- Probe `COMMON_DEV_DIRS` (see section 2)
- If found, scan those automatically
- Show a subtle "Scanning ~/Developer..." indicator

**Tier 2 -- Guided configuration (onboarding):**

- After first scan completes, show: "We found N projects in ~/Developer. Want to add more directories?"
- Provide a directory picker for adding additional roots
- Persist to `mesh.scanRoots` in config

**Tier 3 -- Manual configuration (settings):**

- Settings panel shows configured scan roots as an editable list
- Add/remove roots with directory picker
- Each root shows last scan time and project count
- "Scan now" button per root

**Prior art alignment:**

- VS Code Project Manager: explicit `baseFolders` config (Tier 3 only)
- Git Project Manager: `baseProjectsFolders` + `maxDepthRecursion` + `ignoredFolders` (Tier 3 with depth control)
- JetBrains Toolbox: auto-detects from IDE configs (Tier 1), no manual scan root config needed

---

## Recommendations for DorkOS

### Immediate (unification work)

1. **Keep `scanForAgents` as the single scanner.** It already has the right async generator shape. Both onboarding and mesh panel should use it.

2. **Create a shared `useDiscoveryScan` hook** that wraps the transport call and manages state. Both onboarding's `useDiscoveryScan` and mesh panel's `useDiscoverAgents` should be replaced by this single hook.

3. **Add the scan endpoint to the Transport interface.** Currently discovery scan is only available via HTTP SSE. Add `scan(options): AsyncGenerator<ScanEvent>` to Transport so DirectTransport can use it too.

4. **Lift scan state to a Zustand slice** so results persist across navigation between onboarding and mesh panel.

5. **Add smart default root detection.** Probe common developer directories before falling back to home directory. This dramatically improves first-scan speed and relevance.

### Future improvements

6. **Add `requestAnimationFrame` batching** in the scan hook for fast scans that yield many results.

7. **Cache scan results with staleness tracking.** Show cached results immediately, background refresh.

8. **Add per-root scan status** in settings for granular control.

---

## Sources & Evidence

- [VS Code Project Manager](https://github.com/alefragnani/vscode-project-manager) -- `baseFolders` configuration pattern, auto-detection of Git/Mercurial/SVN repos
- [Git Project Manager for VS Code](https://github.com/felipecaputo/git-project-manager) -- `baseProjectsFolders`, `maxDepthRecursion`, `storeRepositoriesBetweenSessions` caching
- [JetBrains Toolbox 2.2](https://blog.jetbrains.com/toolbox-app/2024/02/introducing-toolbox-app-2-2/) -- project detection from IDE configs, efficient update polling
- [Chrome DevTools Automatic Workspace Folders](https://chromium.googlesource.com/devtools/devtools-frontend/+/main/docs/ecosystem/automatic_workspace_folders.md) -- push-based discovery from devservers
- [Streaming Backends & React](https://www.sitepoint.com/streaming-backends-react-controlling-re-render-chaos/) -- requestAnimationFrame batching for high-frequency streaming data
- [@repeaterjs/react-hooks](https://github.com/repeaterjs/react-hooks) -- useAsyncIter for shared async iterator consumption
- [SSE with React](https://oneuptime.com/blog/post/2026-01-15-server-sent-events-sse-react/view) -- SSE consumption patterns in React
- [L13 VS Code Projects](https://github.com/L13/vscode-projects) -- auto-detection of Git repos, VS Code folders, workspace files
- Existing research: `research/mesh/discovery-patterns.md` -- comprehensive service discovery and filesystem scanning patterns

## Research Gaps

- **Abort/cancel semantics**: How should the UI handle canceling a scan mid-flight? The async generator supports `return()` but the SSE connection needs clean shutdown.
- **Incremental re-scan**: Scanning only directories that changed since last scan (using fs stat mtimes) was not researched.
- **Windows path handling**: Common dev directories on Windows (`C:\Users\X\source\repos`, `C:\dev`) were not covered.
