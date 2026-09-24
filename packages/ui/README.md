# @dork-labs/ui

Portable controls and theme colors for DorkOS interfaces.

In your Tailwind 4 entry CSS, import `tailwindcss` first, then `@dork-labs/ui/tailwind.css` once. That stylesheet includes `tokens.css` and registers the installed JavaScript as a Tailwind source, maps `dui-*` colors and supplies animation utilities; it does not ship a second reset or compiled utility sheet.

Use a `.light` or `.dark` ancestor to select a theme. Without one, the system preference applies. React and React DOM 19 are peer dependencies. Buttons default to `type="button"`; set `type="submit"` for form actions. The `xs` and `icon-xs` sizes remain intentionally compact, and `icon-sm` remains 40px below the medium breakpoint.

The package includes form controls, tabs, scrolling, dialogs, popovers and menus. These are DorkOS's maintained Radix components. Import them from the package root or a component subpath, such as `@dork-labs/ui/dialog`.

Overlays use the document body by default. For a nested theme, pass a mounted element to `UiProvider` as `portalContainer`. Keep that element inside the theme region and mounted while an overlay is open. Each provider keeps its own container; an explicit Portal `container` prop takes precedence.

The package owns colors, icon sizes and reduced-motion behavior. Your application owns theme selection, form state, validation and requests. See the repository's [shared UI guide](https://github.com/dork-labs/dorkos/blob/main/contributing/shared-ui.md) for the component boundary, examples and release procedure.
