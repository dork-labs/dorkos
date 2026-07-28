---
covers:
  - 'fix(shapes): an agent can no longer schedule unattended work without asking (DOR-625)'
  - 'fix(shapes): lex the gate-bypass scan with the TypeScript parser, and reserve shapes.apply for real (DOR-625)'
---

### Security

- Your agent can no longer set up recurring background jobs on your machine
  without asking you. Switching to a Shape does more than rearrange the cockpit:
  it turns on every scheduled job that Shape comes with, and each one runs later,
  on its own timer, with nobody watching. A Shape can also say that its jobs
  should skip every safety prompt. Because switching Shapes was filed under
  "moving things around on screen", an agent could do all of that in one step and
  you would never see a prompt. Now an agent that wants to switch Shapes has to
  ask you first, and you see which Shape before you answer. Clicking a Shape
  yourself is unchanged: no extra prompt, it just switches (DOR-625)
- The rest of what an agent can do to the cockpit is untouched. Opening a panel,
  showing a file, throwing confetti, switching which project you are looking at:
  all still instant, no prompt. Only the one action that reaches past the browser
  and onto your machine asks (DOR-625)
