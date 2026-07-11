### Fixed

- The "agent can start conversations" switch on a chat channel now holds no matter how the agent tries to send. Before, turning it off only stopped the built-in "notify me" action — an agent could still reach you on Telegram or Slack by addressing the raw channel directly. That side door is closed: every agent-started message to a channel is checked against the switch at the moment of delivery, so off means off. Replies to messages you sent first, and your task-done notifications, keep working exactly as before (DOR-277)
