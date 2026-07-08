# Right-Panel Workbench — Task Breakdown

**Spec:** `specs/right-panel-workbench/02-specification.md` · **Generated:** 2026-07-08 · **Mode:** full
**Umbrella:** DOR-211 · **Fast-follows:** DOR-212 (diff viewer), DOR-213 (DevTools bridge)

Each chunk is an `xl` task promoted to its own tracker sub-issue and executed in its own worktree with a named agent + a per-chunk code review (REVIEW.md).

## Dependency graph

```
Phase 1:  A (DOR-217) ────────────┐
                                  ├──> B (DOR-214)
                                  └──> C (DOR-219) ──> D (DOR-216) ──┐
Phase 2:  E (DOR-218, independent) ───────────────────────────────── ├──> F (DOR-215)
                          B, C, E parallel after A                    ┘
```

Critical path: **A → C → D → F**. E runs independently (node-pty spike resolved 🟢).

## Phase 1 — Foundation

### Task 1.1: File-service foundation (DOR-217) — `agent/ready`

Endpoints on `routes/files.ts` (tree, text-content, create, delete, rename; extend `/raw` for 3D MIME), all boundary-validated + atomic; shared Zod DTOs; Transport methods `readFileTree`/`readFileContent`/`createEntry`/`deleteEntry`/`renameEntry` on both HttpTransport and DirectTransport. **Prerequisite for B and C.** size: xl · deps: none.

## Phase 2 — Core surfaces (parallel after A)

### Task 2.1: File explorer UI (DOR-214)

FSD feature `file-explorer/`: lazy tree at `selectedCwd`, workspace/branch badge, context-menu + inline-rename CRUD with optimistic rollback, drag-to-move, click→`open_file`; register `files` right-panel tab. size: xl · deps: 1.1 · parallel: 2.2, 2.3.

### Task 2.2: Viewer matrix + CodeMirror + multi-doc canvas (DOR-219)

First: multi-document canvas store (`openDocuments[] + activeDocumentId`, tab strip, per-doc edit-protection — shared prereq for D). Then: `file`/`model3d`/`csv` canvas variants; `CanvasFileContent` (CodeMirror 6, edit→save); `CanvasModel3dContent` (model-viewer + three.js); `CanvasCsvContent` (papaparse); zoom/pan on images; mime→viewer registry + `workbench.defaultViewers` config. size: xl · deps: 1.1 · parallel: 2.1, 2.3.

### Task 2.3: Terminal (DOR-218)

node-pty spike **resolved 🟢** (ship `node-pty@^1.1.0` mirroring better-sqlite3). Server `services/terminal/` PTY over WebSocket; Transport `openTerminal`/`writeTerminal`/`resizeTerminal` (DirectTransport unsupported); client `terminal/` xterm.js tab hidden under DirectTransport. Add a spawn-a-shell check to `smoke:docker`. size: xl · deps: none · parallel: 2.1, 2.2.

## Phase 3 — Browser + agent control

### Task 3.1: Embedded browser + local-HTML serving (DOR-216, closes DOR-98)

Server signed-URL static serve + localhost reverse-proxy (strips X-Frame-Options); sandbox without `allow-same-origin` (opaque origin); client browser chrome (URL/back/forward/reload) + X-Frame-Options fallback; architected for the DevTools bridge (DOR-213). size: xl · deps: 2.2 (multi-doc).

### Task 3.2: Agent control_ui actions (DOR-215)

`open_file`/`open_terminal`/`browser_navigate` via the 3-place recipe (schema + contract + `applyUiCommandToState`); Codex parity. size: large · deps: 2.1, 2.2, 2.3, 3.1.
