# Form Field Standardization — Task Breakdown

**Spec:** `specs/form-field-standardization/02-specification.md`
**Generated:** 2026-03-18
**Mode:** Full

---

## Phase 1: Foundation

### 1.1 Install Shadcn Field and export from shared barrel

**Size:** Small | **Priority:** High | **Dependencies:** None

Install the Shadcn Field component via CLI (`pnpm dlx shadcn@latest add field`) into `apps/client/src/layers/shared/ui/field.tsx`. Add all 10 exports (`Field`, `FieldLabel`, `FieldDescription`, `FieldError`, `FieldContent`, `FieldTitle`, `FieldGroup`, `FieldSet`, `FieldLegend`, `FieldSeparator`) to the shared UI barrel at `apps/client/src/layers/shared/ui/index.ts`.

### 1.2 Create SettingRow component with tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.3

Create `apps/client/src/layers/shared/ui/setting-row.tsx` — a thin wrapper on `<Field orientation="horizontal">` with `label`, `description`, `children`, and `className` props. Export from shared barrel. Write 4 tests in `__tests__/setting-row.test.tsx` covering: label/description rendering, aria-describedby association, custom className, and compound children.

### 1.3 Create PasswordInput component with tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2

Create `apps/client/src/layers/shared/ui/password-input.tsx` — password input with eye/eye-off toggle supporting controlled (`showPassword` + `onShowPasswordChange`) and uncontrolled (`visibleByDefault`) modes. Export from shared barrel. Write 6 tests in `__tests__/password-input.test.tsx` covering: default password type, toggle visibility, controlled mode, controlled callback, visibleByDefault, and prop forwarding.

---

## Phase 2: Settings Migration

### 2.1 Replace private SettingRow in SettingsDialog with shared import

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.2, 2.3, 2.4, 2.5

Delete the private `SettingRow` function (lines 338-356) in `SettingsDialog.tsx` and replace with an import of `SettingRow` from `@/layers/shared/ui`. Remove unused `Label` import.

### 2.2 Migrate AdvancedTab inline patterns to SettingRow

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1, 2.3, 2.4, 2.5

Replace 2 diagnostics section rows (Cross-client sync, Message polling) in `AdvancedTab.tsx` with `<SettingRow>`. Leave Danger Zone rows as-is (they use `<p>` instead of `<Label>`).

### 2.3 Migrate ToolsTab ToolBlockSection to SettingRow

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1, 2.2, 2.4, 2.5

Replace the inner flex row in `ToolBlockSection` in `ToolsTab.tsx` with `<SettingRow>`, wrapping the Badge + Switch compound children in a flex container.

### 2.4 Migrate ContextTab and CapabilitiesTab to SettingRow

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1, 2.2, 2.3, 2.5

Replace `ContextBlockSection` inner row in `ContextTab.tsx` with `<SettingRow>`. Replace both render paths of `ToolGroupRow` in `CapabilitiesTab.tsx` with `<SettingRow>`. Also migrate the Core Tools info row.

### 2.5 Migrate TunnelDialog and PersonaTab to Field primitives

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 2.1, 2.2, 2.3, 2.4

Replace label-only rows (no description) in `TunnelDialog.tsx` and `PersonaTab.tsx` with `<Field orientation="horizontal">` + `<FieldLabel>` for accessibility benefits, since they don't match the full `SettingRow` API.

---

## Phase 3: ConfigFieldInput Rebuild

### 3.1 Rebuild ConfigFieldInput layout on Field primitives

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.3

Replace `ConfigFieldInput`'s outer layout with `<Field orientation="vertical">` + `<FieldLabel>` + `<FieldDescription>` + `<FieldError>`. Replace inline password rendering with `<PasswordInput>`. Remove `showPassword` state and `Eye`/`EyeOff` imports. Public API unchanged.

---

## Phase 4: Polish

### 4.1 Add SettingRow and PasswordInput showcases to dev playground

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.2, 1.3 | **Parallel with:** 4.2

Extend `ComposedFormShowcases.tsx` with SettingRow showcase (4 variants: Switch, Select, destructive Button, Badge+Switch) and PasswordInput showcase (3 variants: default, visibleByDefault, sentinel mode). Update `forms-sections.ts` with new TOC entries.

### 4.2 Update design system docs and run final validation

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.1-2.5, 3.1, 4.1

Add "Form Fields" section to `contributing/design-system.md` documenting SettingRow, PasswordInput, and Field orientation conventions. Run `pnpm typecheck && pnpm lint && pnpm test -- --run` across all packages.

---

## Dependency Graph

```
1.1 ─┬─ 1.2 ─┬─ 2.1 ─┐
     │       ├─ 2.2  │
     │       ├─ 2.3  │
     │       ├─ 2.4  ├─ 4.2
     │       └───────│─ 4.1 ─┘
     ├─ 1.3 ─┬─ 3.1 ─┘
     │       └─ 4.1
     └─ 2.5
```

**Total tasks:** 10
**Estimated parallelism:** Phase 2 tasks (2.1-2.5) can all run in parallel after Phase 1 completes.
