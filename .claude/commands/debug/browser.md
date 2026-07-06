---
description: Debug and fix browser issues by inspecting, diagnosing, and resolving visual or technical problems
argument-hint: '[issue-description] [--url <url>]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, TodoWrite, AskUserQuestion, Skill, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_network_requests, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_resize, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_evaluate, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
---

# Browser Debug

Debug and resolve an issue observed in the browser — visual (design-system violations, layout), interaction (broken buttons/forms), data (wrong/stale content), or responsive. Parse `$ARGUMENTS`: an optional `--url <url>` flag plus the issue description. If the URL is missing, default to the Vite dev client at `http://localhost:6241` (the Express API is on 6242; `/api` is proxied). If the description is too vague to act on, ask one clarifying question — otherwise just start.

## The loop

Work the issue as an evidence-driven loop. **Never edit code you haven't read, and never claim a fix you haven't re-verified in the browser.**

1. **Capture** — navigate to the URL; take a snapshot; collect console messages and network requests. Check the dev server is up (`curl -s http://localhost:${DORKOS_PORT:-6242}/api/health`) and scan recent server errors:

   ```bash
   LOG="apps/server/.temp/.dork/logs/dorkos.log"   # NDJSON; level >= 40 is warn/error
   tail -200 "$LOG" | python3 -c "
   import sys, json
   for line in sys.stdin:
       try:
           o = json.loads(line)
           if o.get('level', 0) >= 40:
               print(f\"[{o.get('time','')}] {o.get('tag','?')}: {o.get('msg','')}\"[:200])
       except: pass
   " | tail -20
   ```

2. **Classify** — visual (no console errors, looks wrong), interaction (errors on action), data (API failures, stale cache), performance (slow, timing warnings), or responsive (breaks at breakpoints).

3. **Diagnose** — trace the observation to source code and confirm the cause there before changing anything:
   - Client code lives in `apps/client/src/` (FSD layers under `apps/client/src/layers/`).
   - **Visual issues**: load the `designing-frontend` skill for the design-system audit criteria and `styling-with-tailwind-shadcn` for token/component specs — don't re-derive the design system from memory. Take targeted element screenshots to compare against spec.
   - **Interaction issues**: attempt the interaction via browser tools, capture new console errors, then trace the event handler in the component.
   - **Data issues**: trace component → TanStack Query hook (`apps/client/src/layers/entities/*/model/`) → Express route (`apps/server/src/routes/`) → service (`apps/server/src/services/`); check server logs for the failing request. For deep data-flow work, switch to `/debug:api`.
   - **Responsive issues**: resize to 375×667, 768×1024, and 1280×800 and snapshot each; check `sm:`/`md:`/`lg:` class usage and 44px touch targets.
   - For library behavior questions, query context7 (`resolve-library-id` → `query-docs`). For multi-file hunts, dispatch a `code-search` agent; for gnarly type errors mid-fix, `typescript-expert`; for CSS/layout expertise, `react-tanstack-expert`.

4. **Fix** — read the file, make the minimal targeted edit, then `pnpm typecheck` and `pnpm lint`.

5. **Re-verify** — reload the page, snapshot, and confirm: issue gone, no new console errors, no visual regressions. Test the states the fix could plausibly affect (dark mode and breakpoints for visual fixes; success/error states for interactions; loading/empty/error for data). If the issue persists, iterate — review what the last attempt taught you and try the next hypothesis; don't stop after one attempt. Ask the user for more context only when genuinely stuck.

## Wrap-up

Summarize: problem, root cause, what changed, files modified. If you noticed related instances of the same bug or missing design-token usage, mention them. Suggest a regression test where one would have caught this.

If the issue turns out to be too large for a spot fix, offer to escalate to `/flow:specify` (requires the flow plugin, `dork-labs/marketplace`, loaded via `--plugin-dir`).

## Edge cases

- **Dev server not running**: prompt the user to start `pnpm dev` (or `pnpm dev:dogfood`).
- **404/500 on navigation**: check the route exists (`apps/client/src/router.tsx`) and the server log for errors.
- **Suspected hot-reload weirdness**: hard refresh or restart the dev server before chasing ghosts.
- **Multiple issues found**: fix one at a time, track with TodoWrite.
