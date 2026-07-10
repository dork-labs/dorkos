### Fixed

- Agent-to-agent call budgets now actually stop the spending, not just the mail. Before, a message that had run out of budget was correctly refused a mailbox copy — but the target agent still ran a full, paid turn anyway. The budget check now happens once, up front, before anything is delivered: an out-of-budget message is dead-lettered, no agent turn starts, and a caller waiting on a reply gets told immediately instead of timing out (DOR-260)
