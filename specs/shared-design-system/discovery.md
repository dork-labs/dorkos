# Discovery and overlap

Read with [ideation](01-ideation.md). Findings are source inspection, not a visual audit or live-browser validation. Public source base: `2f901e390b70b567370544e7bcad2e20a0dc00ae`, inspected 2026-09-23. Refresh against pinned SHAs before implementation.

## Source evidence

| Path                                                         | Finding                                                                                                                         | Migration implication                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/client/src/layers/shared/ui/button.tsx`                | Radix Slot composition; `xs/sm/md/lg` and icon sizes; default native button type; responsive sizes; reduced-motion press styles | Preserve behavior and consumer API or explicitly migrate call sites   |
| `apps/client/src/layers/shared/ui/touch-target.ts`           | Shared responsive target constants                                                                                              | Preserve exceptions; do not claim every control is already 44px       |
| `apps/client/src/layers/shared/ui/field.tsx`                 | Existing field primitives                                                                                                       | Inspect dependencies before extraction                                |
| `apps/client/src/layers/shared/ui/form-fields/`              | Higher-level form components                                                                                                    | Keep form-engine coupling outside generic UI unless justified         |
| `apps/client/src/index.css`                                  | HSL semantic tokens, user font scaling, mobile scale, editor cascade ordering                                                   | Separate portable theme contract from client-only CSS                 |
| `apps/community/src/browser/styles.css`                      | Independent `canvas/panel/ink` tokens, control classes, dark system media query                                                 | Map semantics intentionally; don't globally rename conflicting tokens |
| `apps/community/src/browser/components/Admission.tsx`        | Form UI alongside admission state and auth calls                                                                                | Migrate controls without moving auth or admission into UI package     |
| `apps/client/src/dev/DevPlayground.tsx`                      | Module-level router, query client and mock transport                                                                            | Entire file is not a portable catalog entrypoint                      |
| `apps/client/src/dev/playground-providers.tsx`               | Transport and event stream contexts                                                                                             | Keep feature simulations with application                             |
| `apps/client/src/dev/playground-pages.ts`                    | Tokens/forms/components alongside rooms, simulator, settings, topology                                                          | Split showcases individually, not merely by page title                |
| `apps/client/src/dev/__tests__/showcase-no-replicas.test.ts` | Guard against demo implementations drifting from production                                                                     | Preserve this property in new catalog                                 |
| `apps/client/src/dev/__tests__/playground-registry.test.ts`  | Registry consistency checks                                                                                                     | Update alongside moved entries                                        |
| `packages/icons/package.json`                                | Workspace-private package with React peer dependency                                                                            | Public distribution must be designed before Cloud relies on it        |

## Relevant Linear history

Read-only adapter searches on 2026-09-23: project names containing `design`; issue terms `shared component`, `design system`, `playground`. These bounded searches did not identify an exact cross-surface shared-library programme. They are not proof that no differently named project exists. Recheck at SPECIFY before creating anything. Only DOR results informed this public plan; unrelated workspace teams were excluded.

| Item                                                    | Observed state | Why the next agent should read it                                   |
| ------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| [DOR-1808](https://linear.app/dorkspace/issue/DOR-1808) | Backlog        | Root `data-slot` conventions for composed shared primitives         |
| [DOR-1812](https://linear.app/dorkspace/issue/DOR-1812) | Backlog        | `icon-sm` size versus mobile touch target remains a design question |
| [DOR-1861](https://linear.app/dorkspace/issue/DOR-1861) | Backlog        | Cascade, tokens and documentation overlap                           |
| [DOR-1867](https://linear.app/dorkspace/issue/DOR-1867) | Backlog        | Shared 44px constant work overlaps extraction                       |
| [DOR-1837](https://linear.app/dorkspace/issue/DOR-1837) | Triage         | Deferred selected-state and motion rulings                          |
| [DOR-1809](https://linear.app/dorkspace/issue/DOR-1809) | Done           | Shared utility barrel isolation from transport                      |
| [DOR-1186](https://linear.app/dorkspace/issue/DOR-1186) | Done           | Showcase rendered a drifted replica instead of the real component   |
| [DOR-1099](https://linear.app/dorkspace/issue/DOR-1099) | Done           | Contrast checks can silently evaluate too little                    |

These are title/state observations, not completed investigations of every issue body. Read full issues before absorbing scope; relate or depend on existing work rather than duplicate, close or reassign it speculatively.

## Existing documentation to maintain during implementation

- `contributing/design-system.md`: canonical location and semantic token contract.
- `contributing/styling-theming.md`: CSS imports, themes, new component procedure.
- `contributing/INDEX.md`: package and catalog routing.
- `specs/dev-playground-navigation-overhaul/`: historical context; preserve historical completed specs rather than rewriting their claims to the new design.
- `specs/dev-playground-chat-simulator/`: feature-local simulator context.
- Architecture docs and diagrams: show shared build-time UI dependencies separately from network protocols. No new server connection is introduced by component extraction.

Cloud's private source inspection notes and source paths are carried only in the ignored handoff. No private control-plane source is needed to build the public packages.
