---
id: 261104-091350
title: Packaged shell guard smoke proves heap and timeout refusals
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The existing packaged shell-guard smoke proves startup and setup-write detection, but not the
resource limits Security requires for DOR-3300. Add the real heap and stall shapes with the
production 512 MB heap and five-second answer timer. Require refusal and a successful next command
after each shape. Warm timing samples must also be checked answers.

This extends functional coverage in desktop-smoke without changing required contexts, retries,
workflow timeouts or discovery. The packaged proof runs on CI only. Rework the fixtures if an
Electron update makes them stop exercising heap exhaustion or a stall; never relax refusal or
recovery to get a green check.
