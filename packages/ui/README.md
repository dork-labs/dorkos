# @dork-labs/ui

Portable controls and theme colors for DorkOS interfaces.

In your Tailwind 4 entry CSS, import `tailwindcss` first, then `@dork-labs/ui/tailwind.css` once. That stylesheet includes `tokens.css` and registers the installed JavaScript as a Tailwind source and maps `dui-*` colors; it does not ship a second reset or compiled utility sheet.

Use a `.light` or `.dark` ancestor to select a theme. Without one, the system preference applies. React and React DOM 19 are peer dependencies. Buttons default to `type="button"`; set `type="submit"` for form actions. The `xs` and `icon-xs` sizes remain intentionally compact, and `icon-sm` remains 40px below the medium breakpoint.
