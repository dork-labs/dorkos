# Migration and verification plan

This is a recommended sequence for SPECIFY, not an executable task decomposition. Read [ideation](01-ideation.md) for boundaries and unresolved choices.

## Phase sequence

1. **Contract and ownership.** Inventory transitive imports for pilot components; choose package/CSS contracts, baseline visuals, theme activation, first screens and reviewers. Record a proposed ADR. Create or reuse the Linear project at this point. Assign file ownership so feature agents and migration agents do not edit the same screens concurrently.
2. **One complete pilot.** Extract portable tokens and Button, Field/Input and Notice behavior. Migrate one real form per primary surface. Public packages must work from a packed archive in a separate consumer before relying on a release for Cloud. Keep application data and auth local.
3. **Shared catalog.** Create `apps/design-system` or the selected equivalent. Move generic examples; retain feature simulations and their transport/router providers in the client. Link between catalog and local playground. Keep examples attached to real exports and migrate registry/coverage gates without weakening them.
4. **Broader adoption.** Move dialogs, menus, tabs and other primitives in bounded slices. Delete superseded local implementations in the same slice. Keep future components local until a justified shared use appears.
5. **Maintenance.** Add contribution guidance, release ownership, supported versions and consumer upgrade checks. Update architectural documentation to match delivered package boundaries.

## Parallel development contract

- One writer per worktree; separate public and private repository worktrees.
- Do not use shared main as scratch space, change its branch, stash its changes or install dependencies there on another agent's behalf.
- Check active work before selecting pilot screens. Do not freeze all Cloud or Community feature development.
- Keep old consumers working until their migration slice lands. A temporary import re-export is acceptable as a documented transition with a removal slice; do not maintain two implementations.
- Shared UI may depend on React and deliberately chosen UI libraries. It must not import application stores, transports, API clients, server modules or private Cloud code.
- App-local wrappers may supply routing, data and business decisions; they must not fork primitive behavior through undocumented overrides.
- No synchronized deployment requirement. Pin or constrain released public package versions in Cloud and upgrade explicitly.

## Proof required for the first slice

| Concern                      | Evidence                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Actual distribution          | Install packed artifacts in a separate consumer; inspect exports, declarations and CSS; build without workspace source aliases         |
| Public/private boundary      | Public build needs no private checkout or credentials; scan new imports and packed file list                                           |
| FSD and dependency direction | Package imports never point into apps; client imports follow public boundaries                                                         |
| Theme behavior               | Light, dark and system choice; no theme flash where currently prevented; portals inherit intended theme; embedded styles remain scoped |
| Responsive behavior          | Representative narrow and wide layouts; touch-target exceptions explicit; font scaling and long labels don't overflow                  |
| Interaction                  | Keyboard focus, disabled/loading states, form submit behavior, errors and labels, reduced motion                                       |
| Visual consistency           | Same component fixtures across all three consumers; deliberate density differences documented                                          |
| Regression scope             | Run every test rendering changed primitives, including through parent components, not only primitive unit tests                        |
| Catalog truth                | Real component exports mounted; registry complete; no swallowed render failures or static replicas                                     |
| CSS boundary                 | Application reset/editor layers remain intact; no dependence on accidentally inherited client styles                                   |

Use browser-testing and verification-before-completion skills for implementation evidence. Existing client Button tests are at `apps/client/src/layers/shared/ui/__tests__/button.test.tsx`; form tests at `apps/client/src/layers/shared/ui/form-fields/__tests__/form-fields.test.tsx`. Discover additional consumers before choosing test commands. Fresh worktrees need dependencies; stale shared package builds can produce false typecheck failures.

Changing pipeline configuration, package gate wiring or catalog ports may touch CI Steward policy. Read that skill before editing those files; a pipeline change requires its own measured ledger entry. New development servers need configurable, isolated ports and the appropriate Turbo environment forwarding.

## Rollout and completion boundaries

Do not report the project complete after publishing a library or creating a catalog. The agreed pilot must be used by all three surfaces, with evidence and duplicate implementations removed within the selected scope. Broader migration can then proceed as separate tracked slices.

At DECOMPOSE, separate public foundations, public consumer adoption, private Cloud adoption, catalog split and documentation/guards into dependency-linked work. Shared contracts and public milestones belong in the public programme; private implementation detail remains private. Shipping a planning PR must not close implementation work through a ticket identifier in its branch/title or a closing keyword.

## Risks and mitigations

- **Component foundation mismatch:** compare composition and event semantics before migration; preserve behavior rather than just matching screenshots.
- **Token mismatch:** define semantic mapping, activation and CSS value format once; do not globally replace HSL values with a different representation without tracing consumers.
- **Over-extraction:** use pure primitives first; a component's current directory is not proof of independence.
- **Catalog becoming another app shell:** keep generic fixtures free of real app state; link to local simulations.
- **Release permission assumptions:** verify package name availability and publishing authority. Existing permission for a different package is not a grant for this one.
- **Unverified accessibility:** test actual rendered controls and ensure contrast checks inspect meaningful nodes.
