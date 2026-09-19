---
covers:
  - 'feat(approvals): say what Full autonomy covers and grant standing permission from the card (DOR-2102)'
---

### Changed

- **Full autonomy now says what it does not cover, everywhere you can turn it on.** It switches off the agent's own permission prompts: editing files, running commands, working outside this project. It does not switch off DorkOS's own questions about risky actions, like deleting a schedule or removing an agent. Those still stop and wait for you on an approval card. That line already appeared in a chat, on a channel connection and on a scheduled task. It now appears in the places it was missing: the shared setting in Settings → Runtimes, any runtime card you have set differently there, and the Power dial in the Control Center. It shows up once per setting rather than once per card, so a page where every agent follows the shared setting says it once. If you have already ticked "don't show this again", those were the only places left that could have told you (DOR-2102)
- The line itself is clearer, and it ends by naming a place rather than giving you an order: "The setting for that is Standing permissions, in Settings under Access." It used to say "actions on DorkOS itself, like removing packages, still ask", which named the rarest example and pointed at a Settings tab that no longer exists. In the Control Center, where the Standing permissions switch is right there on the same panel, the line points at that switch instead of sending you to Settings (DOR-2102)
- **Full autonomy no longer promises more than it delivers.** The dial used to read "Acts on its own. It will not stop to ask you, even for risky steps." Deleting a schedule is about as risky as a step gets, and DorkOS has always stopped for that one. It now reads "Edits files and runs commands on its own. It will not stop to ask you.", with the exception spelled out underneath (DOR-2102)

### Added

- **An approval card that cannot offer "stop asking about this" now tells you how to get it.** Answering once and having DorkOS remember it needs Standing permissions switched on, which needs a login. Until now a card with either one missing simply showed no such button, so it looked like there was no way to stop being asked. The card now says: turn on Standing permissions in Settings, under Access. Cards where DorkOS cannot tell which agent asked stay quiet, because no setting would help there (DOR-2102)
