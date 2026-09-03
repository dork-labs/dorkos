# `shared/ui`

Ninety primitives, one barrel (`index.ts`). This page exists so a component
you need can be found instead of re-implemented — the usual reason a
duplicate shows up in `features/` or `widgets/` is that nobody knew this one
was already here.

Each table below reads _want X → use Y; not Z, because…_ Full API and prop
tables for the overlay wrappers live in
[`contributing/design-system.md`](../../../../../../contributing/design-system.md#responsive-components);
naming and composition conventions live in
[`.claude/rules/components.md`](../../../../../../.claude/rules/components.md).

## Overlays

| Want                                                              | Use                      | Not                  | Because                                                                                                            |
| ----------------------------------------------------------------- | ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A menu of actions in a touch-reachable area (status bar, toolbar) | `ResponsiveDropdownMenu` | plain `DropdownMenu` | swaps to a bottom `Drawer` on mobile                                                                               |
| A menu only ever opened by mouse (dense table, desktop-only tool) | `DropdownMenu`           | —                    | no mobile use, so no wrapper is needed                                                                             |
| Right-click actions on a touch-reachable row or card              | `ResponsiveContextMenu`  | plain `ContextMenu`  | a long-press opens a bottom `Drawer` on mobile                                                                     |
| A floating panel a touch user has to reach                        | `ResponsivePopover`      | plain `Popover`      | swaps to a bottom `Drawer` on mobile                                                                               |
| A centered dialog whose content needs the full screen on a phone  | `ResponsiveDialog`       | plain `Dialog`       | swaps to a full-screen `Drawer` on mobile                                                                          |
| A right-side panel that should fill the screen on a phone         | `ResponsiveSheet`        | plain `Sheet`        | stays a `Sheet` on every size — only its width changes                                                             |
| The bottom-sheet primitive itself                                 | `Drawer`                 | —                    | what every `Responsive*` wrapper swaps to on mobile; use directly only for a surface that is mobile-only by design |

## Rows

| Want                                                               | Use                                                              | Not                                               | Because                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Any row in the sidebar (session, channel, DM, thread, agent)       | `SidebarRow`                                                     | a hand-rolled row                                 | one chrome, one hover ramp, one menu wiring for every row type                 |
| A session, specifically, inside the sidebar's own row grammar      | `SessionRowSidebar` (`entities/session`)                         | `SessionRow`                                      | renders inside `SidebarRow`'s slots — the current sidebar row shape            |
| A session row outside the sidebar (full detail, or a compact list) | `SessionRow` (`entities/session`, `variant="full" \| "compact"`) | `SessionRowSidebar`                               | predates `SidebarRow` and keeps its own chrome for non-sidebar contexts        |
| A settings toggle: label, description, and a control on the side   | `SettingRow`                                                     | `SidebarRow`                                      | pairs a `Field` with a control, not a navigation target                        |
| A whole sidebar submenu (nested rows behind a trigger)             | `SidebarMenuNode`                                                | a hand-rolled `ContextMenu` + `DropdownMenu` pair | one node union drives the right-click menu and the "…" menu from the same data |
| A radio/checkbox option inside a question prompt                   | `OptionRow`                                                      | `SettingRow`                                      | carries selection state (`isSelected`/`isFocused`), not a settings control     |
| A compact one-line status result (a decided or submitted prompt)   | `CompactResultRow`                                               | `OptionRow`                                       | a terminal display, not an interactive control                                 |

## Form controls

| Want                                                                | Use                                                                                                                 | Not                                  | Because                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| A field wired to a TanStack Form: label, control, and validation    | `form-fields/*Field` (`TextField`, `TextareaField`, `SelectField`, `SwitchField`, `CheckboxField`, `PasswordField`) | the raw control plus `Field` by hand | already wires `useFieldContext`, touched-state errors, and the label/description slots |
| The raw control itself, outside a TanStack Form                     | `input.tsx` / `select.tsx` / `switch.tsx` / `checkbox.tsx` / `textarea.tsx`                                         | a `*Field`                           | there is no form context for a `*Field` to wire to                                     |
| A labelled group whose state and errors you own and compose by hand | `Field` / `FieldLabel` / `FieldDescription` / `FieldError`                                                          | a `*Field`                           | the `*Field` family owns TanStack's state; this owns yours                             |
| A toggle inside a settings panel                                    | `SettingRow` (see Rows, above)                                                                                      | `SwitchField`                        | a settings panel is not a TanStack Form                                                |
