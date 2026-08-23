---
covers:
  - 'refactor(server): the stop clock becomes the control-request clock (DOR-1301)'
  - 'fix(server): a permission-mode change no longer hangs the PATCH (DOR-1301)'
  - 'fix(server): one deaf setter no longer wedges a warm dispatch (DOR-1301)'
  - 'fix(server): the plugin reload and the model probe get deadlines (DOR-1301)'
  - 'fix(server): the launch probes stop waiting on a subprocess that cannot hear them (DOR-1301)'
  - "fix(server): an unconfirmed plugin reload answers 504, not 'send a message first' (DOR-1301)"
---

### Fixed

- Changing a chat's permission mode while its agent is finishing up no longer hangs. DorkOS now gives every behind-the-scenes request a deadline and tells you when one couldn't be delivered (DOR-1301)
- Sending a message to a chat whose settings changed no longer gets stuck waiting on the agent to confirm. The settings that went through are applied, the ones that didn't are left for the next message, and your message starts either way (DOR-1301)
- Reloading plugins after installing something from the Marketplace now finishes instead of waiting forever on an agent that has already stopped listening. If the agent doesn't confirm, you're told the reload may still have worked — instead of being told to send a message you already sent (DOR-1301)
