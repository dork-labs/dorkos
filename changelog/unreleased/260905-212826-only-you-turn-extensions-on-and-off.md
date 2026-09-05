---
covers:
  - 'fix(server): only a person turns an extension on or off (DOR-1507)'
---

### Security

- Turning an extension on or off is now yours alone. DorkOS already refused an agent that request when it came through settings, but the Extensions screen had its own way in that asked nobody — so an agent, or a web page you happened to be visiting, could switch your extensions on and off behind your back. Both are refused now, in both directions, and DorkOS says what it did not do and who can do it. Nothing an extension does actually ran without your say-so either way: an extension still needs your one-time approval before its code runs anywhere (DOR-1507)
