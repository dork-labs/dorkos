---
id: 261111-080500
title: The existing macOS desktop smoke proves native guest identity and debugger detachment
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.desktop-smoke.packaged-runtime
prs: []
ratchet-release: []
field-changes: []
---

The existing desktop smoke invokes one extra CI-only native guest spec in its debugging-switch probe. It starts stock Electron with a throwaway HOME, DORK_HOME, CLAUDE_CONFIG_DIR and profile, plus DORKOS_TEST_RUNTIME=true. It starts no DorkOS server and uses no native DB modules, real sign-ins, accounts or public websites.

A local echo page proves the request UA, JavaScript UA and client hints use the actual engine version without app tokens. The native host witnesses debugger attachment before a handoff, no attachment during it, a refused reconnect while detached, fresh CDP on hand-back, and no attachment after Stop. It also asserts webdriver is false during the detached steps; it never changes that value. The spec runs only on macOS CI. No new job, runner, required context, job timeout or retry is added. The native child has a 60-second ceiling.

The same macOS job also ensures Google Chrome is installed and runs an isolated public-site proof. A throwaway Node child uses production browser launch, handoff and plain-window code. A local echo records UA, real Google Chrome brands, client-hint headers and webdriver=false in the plain window, without connecting a debugger. BrowserScan and the GoDaddy sign-in form have screenshots before handoff and native screenshots during it. Native OCR waits for the actual page, and GoDaddy must show its form without a wall. Nothing is typed and no account is used. Stop must keep the plain window open. Screenshots and UA receipts upload even when the proof fails. The child has a six-minute ceiling, inside an eight-minute step; the existing job ceiling stays unchanged.

Files covered: .github/workflows/desktop-smoke.yml, apps/desktop/scripts/smoke-public-chrome.ts, apps/desktop/scripts/local-browser-ci/public-chrome.ts, apps/desktop/scripts/local-browser-ci/capture-window.swift, apps/desktop/scripts/smoke-launch-switches.ts, apps/desktop/scripts/smoke-local-browser.ts, apps/desktop/scripts/local-browser-ci/fixture.ts.

The installed Chrome leg also captures the agent window natively, including the browser frame and profile avatar, for the designer’s orange/name/avatar check. Production writes only built-in profile prefs before launch; Chrome keeps extensions disabled. The plain handoff clears the agent’s orange and changes its profile label to You · DorkOS.
