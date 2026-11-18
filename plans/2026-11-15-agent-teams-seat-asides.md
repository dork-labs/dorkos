# Agent teams: private writes to room seats

DOR-4472 Parts B+C. Baseline a23056f0a528393a9f3eea312c516ed8660f77b6. Final decisions: D1 answers and D2 unsolicited writes are allowed only through the seat aside. Unsolicited writes emit a constant body-free room trace. D3 Telegram/Slack closed with no switch; D4 beats/schedules unchanged. Never widen CHAT_SENDABLE_ORIGINS.

Read the copied Security design in .temp/coord/codex-agent-teams. Freeze a concrete specification and task list for M2/M3/M4/M5/M6/M7/M8/M9, moved-seat refusal and chat_send never posting body into room. Source code starts after root approves design and first two slices are pushed/reviewed in order. Root owns tracker; Code owns fresh PR review, Security, arming, release and Done. PR hold+review:deep.
