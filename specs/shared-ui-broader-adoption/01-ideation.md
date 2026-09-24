---
slug: shared-ui-broader-adoption
number: 260924-130508
created: 2026-09-24
status: ideation
---

# Shared UI: broader primitive adoption and maintenance

## 1) Intent & Assumptions

Complete phases 4 (broader adoption) and 5 (maintenance) of `specs/shared-design-system/migration-plan.md`. DOR-2280 delivered the first three phases and the initial maintenance guidance. DOR-2315 owns this continuation. The operator explicitly requested continued work through all remaining phases.

Preserve the existing modified Radix implementations, React 19 APIs, responsive sizing and application behavior. Use worktrees for all writes. Independent consumers must remain independently buildable and releasable. Public documents contain only public contracts and contract-level verification results.

Out of scope: a Base UI migration, freshly generated upstream replacements, application-state extraction, changes to authentication or Community protocols, forcing custom selects onto native form controls, and wholesale extraction of every file under shared/ui.

## 2) Pre-reading Log

- Original ideation, discovery, migration plan and completed specification/tasks: preserve the agreed portability and ownership boundary.
- `decisions/260923-201140-share-ui-through-a-public-package.md`: namespaced CSS and independent public distribution remain the architecture.
- `packages/ui/` and `apps/design-system/`: published 0.1.0 foundations and production catalog are the starting point.
- Client shared UI import census: many apparent primitives depend on stores, router, transport or domain schemas; these stay local.
- Client controls, dialog, dropdown menu, popover, hover card, tooltip and CSS: existing custom behavior includes async Radix keyboard focus, immediate menu dismissal, responsive sizes, overflow handling and custom animation/elevation utilities.
- Open public PR inventory: no current changes to packages/ui, apps/design-system or client shared/ui; active Community work overlaps Admission, Channel and administration screens. Recheck before integration.

Public baseline pinned at `6ca1e5b8410f2a2b4f73beb3fcf4a15d70187e9a`.

## 3) Codebase Map

Source: `apps/client/src/layers/shared/ui/`. Destination: `packages/ui/src/`, re-exported through existing client leaf files and FSD barrel. Catalog: `apps/design-system/src/`. Styles: package tokens/Tailwind entry, preserving client host scale bridges. Existing client tests remain consumer regression tests.

Three bounded extraction slices: (A) Textarea, Checkbox, RadioGroup, Switch, Slider, Tabs, Collapsible, Progress and ScrollArea; (B) Dialog, AlertDialog, Sheet, Popover, HoverCard and Tooltip; (C) Select, DropdownMenu and ContextMenu. These 18 modules are generic controls and interaction primitives already used by real client features. Their existing callers migrate automatically through the facade; the catalog demonstrates the same package exports.

Card and Skeleton depend on additional app-specific utility semantics; Badge depends on status vocabulary. Responsive wrappers, Drawer, data tables, navigation, notifications, identity/domain controls, Markdown, form engines and routing stay local. They compose extracted primitives where applicable. This is a deliberate ownership boundary, not a pending duplicate migration.

## 5) Research

Direct extraction preserves established behavior and minimizes consumer churn. Fresh upstream installation discards modifications; changing foundations adds unrelated risk. Extracting every shared/ui file would invert dependencies. Selected controls are portable after replacing cn, semantic colors, icon-size variables and local CSS assumptions with package-owned contracts.

Portals need explicit container support: default document-level portals preserve existing app behavior; a caller-provided themed container supports embedded or nested theme scopes without a second app theme store. Animation utilities must be present in an independent installed consumer, and reduced motion must work without a client-wide reset.

## 6) Decisions

| Decision                | Choice                                                                                          | Rationale                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Foundation              | Existing customized Radix components                                                            | Preserve API and behavior                                                     |
| Extraction scope        | 18 modules in three slices                                                                      | Completes broader primitive adoption without exporting app state              |
| Portal scoping          | Optional shared provider with caller-owned container                                            | Preserve default portals and support explicit theme islands                   |
| Internal icons          | Existing public lucide-react shapes                                                             | No private icon registry dependency or icon redesign                          |
| Consumer changes        | Client facade plus independently tested package upgrade                                         | Do not redesign native controls or overwrite active Community feature work    |
| Remaining local modules | Explicit ownership matrix                                                                       | A local domain wrapper is valid; duplicated primitive implementations are not |
| Release                 | Additive 0.2.0 candidate; publish only after exact archive proof and authorized owner procedure | Preserve 0.1.0 callers and independent upgrades                               |

Next: specify the three slices, catalog coverage and compatibility/release checks, then decompose and execute. No product preference needs clarification before specification.
