---
covers:
  - 'feat(client,shared): full power reads green; red is reserved for alarms (DOR-1431)'
---

### Changed

- Setting an agent to full autonomy now reads green everywhere it shows up — the dial, the word in the status line, the mark beside a chat in an agent's Sessions list, the Settings note, the confirmation dialogs. It used to read red, which told you off for choosing the thing DorkOS is for.
- Red is now saved for real problems. Nothing about a permission setting you chose on purpose is painted in the colour that means "something is wrong", so when you do see red, it means something.
- **Ask first** now shows a small padlock instead of a shield, because it is the setting that holds the agent back. It stays plain and uncoloured — nothing shames the careful choice.
- The banner about integrations and scheduled tasks running unattended is now a plain note rather than a warning. It reads "Running unattended at full power:" and names them, and it still cannot be dismissed while it is true, with the same links to Integrations and Tasks.
- The Settings note under **Where new conversations stop for you** now says "New sessions run at full power" instead of "New sessions run without asking", and still offers **change** to put it back.
- Open an agent and go to **Sessions**: a chat running at full power is marked with a green lightning bolt instead of a red crossed-out shield, and hovering the bolt reads "This chat runs any command without asking". Expanding that chat's details shows a green **Permissions** line to match, so the mark and the words never disagree. The DorkOS sidebar in Obsidian gets the same green bolt.
