### Fixed

- The mesh network map no longer lists an agent's teammates as if they were external connections (Slack, webhooks, and so on). With two or more agents in the same project, the map used to show each agent's siblings as "adapters" by mistake.
- The network map now shows the access rules that actually protect your projects from each other, not just the ones you added by hand. Before, the map said there were no rules at all, even though agents in different projects were already blocked from talking to each other by default.
