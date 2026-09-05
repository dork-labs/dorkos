---
covers:
  - 'fix(server): only a person turns an extension on or off (DOR-1507)'
  - 'fix(server): an agent cannot squat an extension id in the other scope (DOR-1507)'
---

### Security

- Turning an extension on or off is now yours alone. DorkOS already refused an agent that request when it came through settings, but the Extensions screen had its own way in that asked nobody — so an agent, or a web page you happened to be visiting, could switch your extensions on and off behind your back. Both are refused now, in both directions, and DorkOS says what it did not do and who can do it. Nothing an extension does actually ran without your say-so either way: an extension still needs your one-time approval before its code runs anywhere (DOR-1507)
- An agent can no longer create a second extension under a name you already use. DorkOS keeps extensions in two places — one for you, one inside a project — and it used to check only the place it was writing to. So an agent could put its own `notes` in your project while your own `notes` sat in the other place, and that copy could quietly take over the name later, after you had switched the original off. Now a name you are already using is refused in both places, and the message says where the existing one lives (DOR-1507)
