# Multi-Session Agent Management, Remote Interaction, Scheduling, and Notification Research

**Date**: 2026-02-27
**Depth**: Deep Research
**Searches Performed**: ~20 targeted queries + 12 page fetches

---

## Research Summary

The AI coding agent ecosystem is undergoing a rapid transition from single-session, desk-bound workflows to parallel, asynchronous, and mobile-accessible patterns. Power users are routinely running 4–20 concurrent agent sessions; sessions range from several minutes to 7+ hours; and the tooling ecosystem for managing multi-session state is immature and mostly composed of DIY tmux scripts and one-off Telegram bots. Anthropic's own Remote Control feature (launched February 24, 2026) directly validates that remote agent management is a real market need. Autonomous scheduling has strong appetite but fragile execution — teams universally settle on a PR-gate or human-on-the-loop model rather than pure autonomy.

---

## Topic 1: The Multi-Session Agent Problem

### Current State

The parallel-agent workflow has crossed from experiment into mainstream power-user practice in 2025–2026. Key data points:

- **Boris Cherny** (creator of Claude Code) reportedly runs **10–20 agents in parallel** at any given time.
- **Anthropic's own 2026 Agentic Coding Trends Report** documents teams running **5–10 sessions locally** (e.g., 5 on a MacBook using separate git checkouts, 5–10 on the web) as a standard pattern.
- The **incident.io engineering blog** documents running "four or five Claude agents, each working on different features in parallel" with "up to seven ongoing conversations at once, each evolving independently."
- The author of the DEV Community parallelization piece runs **4 agents simultaneously** (2 Claude Code + 2 Codex instances) as their standard workflow.
- One OpenClaw power user reports orchestrating **5 master instances + 10 satellite agents** running **20+ scheduled tasks per instance** continuously.

These are power users, but they represent the trajectory of where the median developer is heading.

### Session Duration

The claim that sessions run "several minutes to an hour+" is well-supported and, if anything, understated:

- **Typical interactive tasks**: 4–15 minutes per round-trip for focused feature work.
- **Complex agentic tasks**: hours. Rakuten engineers used Claude Code on a technical task that **ran for 7 hours of autonomous work**.
- **Long-horizon autonomous agents**: Cursor has documented agents operating **autonomously for close to a week**, writing over a million lines of code across 1,000 files to create a web browser from scratch.
- **OpenAI Codex** has been documented sustaining **24+ hour autonomous sessions**.
- The 2026 Agentic Coding Trends Report frames the trend explicitly: agents are "progressing from short, one-off tasks to work that continues for hours or days."

The practical implication: developers running 4+ concurrent sessions will routinely have agents active for 15 minutes to several hours, making continuous monitoring untenable.

### Key Pain Points (With Evidence)

**1. Context Loss When Switching Between Sessions**

Developers lose their own context even when the agent retains its. One article advises: "When you switch desktops, you've lost context, though the AI hasn't. Ask the agent 'Give me a quick briefing. What have you done? Where are we in the plan?'" This is a fundamental UX failure — developers must reconstruct their own mental model of what each agent is doing.

**2. Branch and Worktree Tracking**

With parallel git worktrees (the dominant isolation approach), tracking is error-prone:
- "I can't tell which branch a worktree was most recently rebased onto" without external documentation.
- No built-in way to send identical prompts to all agents simultaneously.
- Port confusion when multiple dev servers run across worktrees.

**3. File Conflict and Coordination**

Running agents against the same codebase without worktree isolation causes "stepping on each other in the same working directory." The multi-agent orchestration research identifies "observability nightmares" and "file conflicts" as top challenges.

**4. No Completion Notification**

The overwhelming reason developers build Telegram bots, Pushcut integrations, and custom hooks is captured simply: "You check back five minutes later. Still waiting. Ten minutes later? Still waiting." The constant terminal-watching behavior is the #1 friction point motivating the entire notification ecosystem.

**5. Resource Contention**

Running 10+ Claude instances "will max out your system" without careful management. API quota exhaustion is a real concern — one power user describes sophisticated scheduling to avoid Thursday overage charges.

**6. No Unified Status View**

Raw tmux "requires memorizing session names and switching commands." There is no native unified view across multiple Claude Code sessions. Every tool in this space (Claude Squad, Agent of Empires, the OpenClaw Mission Control) exists because this gap is real.

### Current Solutions and Tools

| Tool | Approach | Limitations |
|------|----------|-------------|
| **tmux + git worktrees** | Terminal multiplexer, separate directories per agent | Manual, no notifications, high cognitive load |
| **Claude Squad** | TUI managing multiple sessions with navigation | No notifications, terminal-only |
| **Agent of Empires** | Rust TUI with status dashboard over tmux | Terminal-only, niche |
| **par (coplane)** | CLI for parallel worktree + session management | Narrow scope |
| **gwq** | Status dashboard for active worktrees | Status-only, no management |
| **Claude Code Agent Teams** | Built-in orchestration (experimental) | Disabled by default, limited session resumption |
| **ccswarm** | Coordinating agents with specialized pools | Complex setup |

The common thread: all existing solutions are terminal-centric, require manual configuration, and lack robust notification or mobile access.

### Implications for DorkOS

DorkOS is positioned uniquely because it provides a **browser-based UI** — something none of the terminal tools offer. The multi-session problem creates clear product requirements:

1. A unified session dashboard showing status across all active Claude Code instances.
2. Session-to-task labeling so developers can answer "which session is doing what" at a glance.
3. Completion and attention-required notifications that escape the terminal.
4. Worktree-aware session management that surfaces branch context alongside session context.

---

## Topic 2: Remote AI Agent Interaction

### Current State

Remote agent interaction has moved from a niche workaround to a validated product category in early 2026. The clearest evidence: **Anthropic launched Claude Code Remote Control on February 24, 2026** — 3 days before this research was written — as a research preview for Max plan subscribers.

From the official docs: "Continue a local Claude Code session from your phone, tablet, or any browser using Remote Control. Works with claude.ai/code and the Claude mobile app. Start a task at your desk, then pick it up from your phone on the couch or a browser on another computer."

Critically, the feature was announced as a **research preview** — meaning Anthropic is learning from early adopters, not shipping a complete product. Simon Willison's early review noted it is "a little bit janky right now" with authentication errors, API 500s, and no graceful session restart handling.

### Is Remote Agent Interaction a Real Pain Point?

Yes, and the community has been solving it with DIY tools for months before Anthropic shipped Remote Control:

**Community-built solutions (pre-Remote Control):**
- **claude-code-telegram** (1.8k GitHub stars, 208 forks): Telegram bot for remote Claude Code access. The star count for a niche developer tool indicates substantial demand.
- **Claude-Code-Remote** by JessyTsui: Control Claude Code via email, Discord, and Telegram. "Start tasks locally, receive notifications when Claude completes them, and send new commands by simply replying to emails."
- **Claudegram**: Bridges Telegram to full Claude Code agent running locally.
- **CCNotify**: Desktop notifications for Claude Code, alerting when Claude needs input or completes tasks.

**The core use case is not "mobile coding" — it is monitoring and steering:**

> "Remote Control solves a specific workflow problem: the long-running task you can't babysit. Start a refactoring job, a test suite, or a deployment pipeline in Claude Code. Walk away. Monitor and steer from your phone."
> — DevOps.com on Claude Code Remote Control

The Justin Searls phone notification post captures the workflow precisely: the author configured Pushcut on iPhone/Apple Watch specifically to know when a 4-5 minute Claude Code task was done, so they could stop staring at the screen. The script is smart enough to not notify if the terminal is already focused.

**Push notifications for approval prompts** were cited as the most-wanted next feature for Remote Control — confirming that the second critical remote use case is not just observing but responding to agent decision points.

### What "Working Away From Desk" Actually Looks Like

The evidence paints a specific picture:
1. Developer starts a long-running agent task at their desk.
2. They walk away — to a meeting, gym, another room, coffee shop.
3. They want to know when the agent is done or stuck.
4. They want to provide direction without returning to their laptop.

One OpenClaw power user describes orchestrating agents "via Slack while remote: coding at the gym on my phone... via Slack... in between bench pressing 315 lbs." This is colorful but illustrates the genuine async nature of agent workflows.

The Fortune article about autonomous agents quotes one user describing "leaving a party early...to get back to his agents" — evidence that the absence of good remote monitoring creates real life disruption.

### Browser-Based UI Value Proposition vs Terminal-Only

The case for browser-based UI over terminal-only:

1. **Accessibility**: Mobile browsers exist everywhere; terminal SSH requires specific setup.
2. **Approvals**: Reviewing and approving agent tool calls is far more ergonomic in a UI with context than in a terminal.
3. **Onboarding**: Browser UI reduces the tool-learning burden that 43.4% of developers cite as a barrier to agent adoption.
4. **Session history**: Rich message history with rendered markdown, code blocks, and tool results is a browser-native experience.
5. **Multi-session overview**: A dashboard view is a UI concept, not a terminal concept.

Remote Control's limitations confirm the gap: "One remote session at a time" and "terminal must stay open." DorkOS's architecture — sessions derived from SDK JSONL files, independent of any terminal process — already sidesteps both limitations.

### Implications for DorkOS

1. Remote Control from Anthropic validates the market but ships with significant constraints (Max plan only, one session at a time, terminal-dependent). DorkOS's model (browser-based, all sessions visible, terminal-independent) is architecturally superior for multi-session remote management.
2. Mobile-optimized approval flow (the most-wanted Remote Control feature) is a clear near-term feature opportunity.
3. The Telegram/email notification ecosystem shows developers will route around missing notifications by whatever means necessary — DorkOS should provide first-class notification integration rather than forcing DIY hooks.

---

## Topic 3: Autonomous Agent Scheduling

### Current State

Scheduled/autonomous agent execution has moved from research demo to production tooling in 2025–2026. Key players and their approaches:

**GitHub Copilot Coding Agent (GA since September 25, 2025):**
- Runs inside GitHub Actions infrastructure.
- Triggered by assigning issues to Copilot or prompting in VS Code.
- Explores repo, writes code, passes tests, opens a pull request.
- The asynchronous/background nature makes "scheduling via GitHub Actions cron" a natural extension.
- All Copilot coding agent PRs require human approval before CI/CD workflows run.

**Devin (Cognition AI):**
- "Goal-Oriented Autonomy" model: developer assigns high-level goal, Devin works independently in cloud sandbox until complete.
- After processing, presents a detailed execution plan for human approval before starting.
- Goldman Sachs piloted alongside 12,000 human developers in 2025, describing a "hybrid workforce" with 20% efficiency gains.
- Pricing democratized to $20/month entry level in mid-2025.
- Supports API-driven task triggering, enabling integration into custom scheduling workflows.

**OpenClaw:**
- Open-source, self-hosted.
- Explicit scheduling: "Every morning at 7 AM IST, give me traffic update and top headlines" — cron-style scheduling is a first-class feature.
- Mission Control dashboard provides "20+ scheduled tasks per instance" management.

**DorkOS Pulse (existing):**
- DorkOS already ships scheduled agent execution via the Pulse scheduler (SQLite-backed, croner-powered).
- Agents can create schedules that enter `pending_approval` state — matching the industry-standard approval gate pattern.

### What Tasks Are Being Automated

The clearest automation targets follow a common risk/value pattern:

**High-value, safe-to-schedule (low risk of irreversible action):**
- Daily code health checks and linting reports.
- Dependency update PRs (Dependabot-style, but AI-authored).
- Test suite generation for new code.
- Documentation generation from code changes.
- Morning standup summaries from git commits.
- Performance benchmark runs with regression detection.

**Higher-risk, requiring approval gates:**
- Refactoring across multiple files.
- Database migrations.
- Deployment pipeline execution.
- Any action touching external systems (email, APIs, file deletion).

### Risks and Failure Modes

The Fortune article (February 2026) provides the most candid real-world account:

- **Cascade failure**: "A system that's 95% accurate on individual steps becomes chaotic over a 20-step autonomous workflow." Error rates compound multiplicatively over long horizons.
- **Ignoring guardrails**: One user reported their agent "deleted her entire inbox, ignoring instructions to pause and ask for confirmation first" — prompting them to "RUN to my Mac Mini like I was defusing a bomb."
- **Token anxiety**: Rather than truly sleeping while agents work, most practitioners end up "checking logs constantly."
- **Domain sensitivity**: High-stakes domains (financial systems, security tooling, email) require extensive guardrails that are difficult to specify correctly in advance.
- **Memory degradation**: "Maintaining coherent context across extended tasks remains problematic."

**Security-specific risks (from Cloud Security Alliance, AWS):**
- Exposed databases and weak auth from agents provisioning infrastructure.
- Leaked API keys from agents that write code with hardcoded credentials.
- Agents that can spend money without rate limits.

### How Teams Handle the Trust/Approval Problem

The industry has converged on a "human-on-the-loop" (HOTL) model rather than pure human-in-the-loop (HITL):

1. **Tiered autonomy**: Tasks are classified by risk. Low-risk tasks run fully autonomously; medium-risk tasks flag for async review; high-risk tasks require synchronous approval.
2. **PR as the universal gate**: Almost every production autonomous agent workflow surfaces output as a pull request requiring human review. "No agent PR merges without two human approvals" is an emerging standard.
3. **Read-only first**: Successful enterprise deployments start with agents that can only analyze (not change), building trust before granting write access.
4. **Audit trails**: All agent actions logged for compliance and retrospective analysis.
5. **Explicit off button**: Considered a minimum requirement for safe autonomous deployment.

The minimum security baseline identified by practitioners: "Logs you can review, rate limits, human approval for high-impact steps, and an actual off button."

### Appetite for "Agents That Run While You Sleep"

Strong but tempered. The 2026 Agentic Coding Trends Report frames it as a trajectory, not a current reality: "organizations are moving from single coding agents to groups of specialized agents working in parallel under an orchestrator." The appetite is genuine; the execution tooling is not yet trustworthy enough for most teams to commit fully.

The differentiator is task selection: teams with clear, well-bounded, low-risk task definitions report success. Teams attempting to use autonomous agents for open-ended or relationship-dependent work report "constant monitoring, guardrails, and intervention."

### Implications for DorkOS

1. DorkOS Pulse already implements the right pattern — `pending_approval` state for agent-created schedules. This is the correct architecture validated by the industry.
2. The PR-as-gate pattern suggests DorkOS should consider surfacing git diff / PR preview in the session UI so developers can review autonomous output before it merges.
3. "The off button" — session cancellation with clear status — is a minimum-viable trust feature that DorkOS must handle robustly.
4. Scheduling for low-risk, repeating tasks (daily reports, health checks, dependency updates) is the highest-appetite, lowest-friction entry point for autonomous execution.
5. Detailed run history and audit logging (Pulse already has run history) is a trust-building feature, not just a nice-to-have.

---

## Topic 4: Developer Notification Preferences

### Current State

Developers receive an average of 200+ notifications daily across platforms. 68% cite "constant interruptions" as their biggest productivity killer (2024 Stack Overflow survey data). The challenge is not "how do we add more notifications" but "how do we add the right notifications at the right time."

### Channel Preferences

The CI/CD notification ecosystem — the closest analog to agent notification — reveals clear preferences:

**Most adopted channels (in order):**
1. **Slack** — dominant for team notifications; tight GitHub/GitLab integration via Actions; supports threaded replies for progressive updates.
2. **Email** — universal fallback; Claude-Code-Remote uses email reply-to-command as a remote interaction primitive.
3. **Discord** — increasingly common for developer-centric teams; Claude-Code-Remote explicitly supports it.
4. **Telegram** — dominant for individual developer notifications; the claude-code-telegram ecosystem (multiple repos, 1.8k+ stars on the leading implementation) demonstrates strong demand.
5. **Push notifications (mobile)** — Pushover, Pushcut, ntfy.sh for individuals; the Justin Searls Apple Watch notification approach is representative of power-user behavior.
6. **Desktop OS notifications** — macOS/Linux native notifications via Claude Code hooks; most accessible entry point, no additional service required.
7. **Microsoft Teams** — enterprise-only; mentioned alongside Slack in CI/CD tooling.

### How CI/CD Notification Patterns Inform Agent Design

CI/CD has solved many of the same notification design problems agents now face. Key transferable patterns:

**1. Notify on failure, not success (or make success opt-in)**
The CI/CD best practice is: always notify on failure; notify on success only for key milestones. For agents, the equivalent is: notify when the agent needs input or is stuck; notify on completion; suppress intermediate progress unless requested.

**2. Thread-based progressive updates**
Slack CI/CD integrations post a "Deploying..." message, then use threaded replies for each pipeline stage, and update the final status in the original message. This "single thread per run" pattern reduces notification volume while preserving full audit trail. Agent sessions map naturally to this pattern.

**3. Action-in-notification**
GitHub PR review notifications include approve/reject buttons directly in Slack. The most-wanted feature for Claude Code Remote Control is "push notifications for approval prompts" — directly analogous. The agent equivalent is: the notification should allow the developer to approve a tool call from their phone without opening a laptop.

**4. Smart suppression**
The Justin Searls Pushcut integration is instructive: it "won't notify you while your terminal is focused and the display is awake." This context-aware suppression prevents notification fatigue during active work while ensuring alerts reach developers when they've stepped away.

**5. Alert grouping and deduplication**
"Instead of multiple alerts, teams receive a single notification indicating 'web service degradation' with all related symptoms." For agents: rather than notifying for every tool call, group into meaningful events (task started, task needs approval, task completed, task failed).

### Tolerance for Notification Noise

Very low. The 28% figure — teams that forget to review a critical alert because of notification fatigue — represents direct business cost. The agent notification problem compounds this: developers running 5+ concurrent agents could receive dozens of status updates per hour if notifications are not carefully designed.

The actionable framework: **three notification types only**

1. **Needs attention now** — agent is blocked waiting for a decision (approval prompt, question, error). These should be high-priority across all channels.
2. **Task completed** — agent finished successfully, output ready for review. These should be low-friction, dismissible.
3. **Task failed** — agent encountered an unrecoverable error. These should include error context and recovery suggestions.

Everything else (progress updates, tool call logs, intermediate results) should be accessible on-demand in the UI but not pushed.

### Emerging Patterns for Agent Status Communication

**The "briefing on demand" pattern**: Since developers context-switch away from sessions, the expectation is shifting from real-time updates to on-demand briefings. "What have you done? Where are we?" becomes the standard session re-entry workflow.

**Async approval as a first-class workflow**: Rather than requiring developers to be present for tool approvals, the pattern is moving toward queued approvals with notifications — the developer receives a notification on their phone, reviews the proposed action, and approves/denies via a simplified interface, without needing to open a terminal.

**Cost and resource status alongside task status**: The OpenClaw Mission Control includes "LLM Fuel Gauges" showing token usage and costs alongside task status. As API costs become significant at scale, quota/cost awareness is becoming part of the notification surface.

### Implications for DorkOS

1. **Telegram integration** is the highest-value near-term notification channel for individual developers. The existing DorkOS relay system with a `telegram-adapter` positions this well.
2. **Slack integration** is the highest-value channel for teams. The relay adapter pattern supports this.
3. **Mobile push notifications for approval prompts** is the most-wanted feature in this space (cited explicitly by Remote Control users). DorkOS's existing tool approval flow needs a mobile-accessible surface.
4. **Notification design should follow the CI/CD pattern**: three types (needs attention, completed, failed) with threading and deduplication.
5. **Smart suppression** (don't notify if the developer is actively in the session) should be table stakes to prevent notification fatigue.
6. The **relay/adapter architecture** DorkOS has already built is the correct technical foundation — adding notification adapters (Slack, Telegram, Discord, email) is an adapter implementation problem, not an architectural one.

---

## Key Findings Summary

### The Market Evidence

1. **Multi-session is mainstream among power users**: 4–20 concurrent sessions is normal for practitioners, not an edge case. This will trickle down as the tooling matures.
2. **Sessions last minutes to days**: The "several minutes to an hour+" framing is directionally correct but understates the upper bound. Seven-hour and multi-day sessions are documented.
3. **The terminal tooling is fragile DIY**: Every existing solution for multi-session management (tmux, claude-squad, agent-of-empires) requires significant manual configuration and provides no notifications or mobile access.
4. **Anthropic validated the remote access market**: Launching Remote Control on February 24, 2026 is the strongest possible signal that developers want cross-device agent access. The feature's constraints (Max plan only, one session, terminal-dependent) create an opening for DorkOS's architecture.
5. **Scheduling has appetite, guardrails are mandatory**: No serious deployment runs agents without an approval gate. DorkOS Pulse's `pending_approval` pattern is validated by the industry.
6. **Notifications are fragmented and DIY**: The existence of multiple Telegram bots, Pushcut integrations, and hook scripts proves the demand. No product has solved this cleanly.

### DorkOS's Strongest Differentiation

Against the current landscape, DorkOS has three architectural advantages that are genuinely hard to replicate:

1. **Multi-session visibility without terminal dependency**: Sessions are derived from SDK JSONL files, making all sessions visible regardless of how they were started. This sidesteps the "terminal must stay open" limitation of Remote Control.
2. **Browser-based UI with mobile access**: Browser-first means any device with a browser can observe and steer agents. This is architecturally superior to terminal-based tools for the remote management use case.
3. **Relay adapter architecture for notifications**: The existing relay system with Telegram, Slack, and webhook adapters provides a principled foundation for cross-channel notifications, rather than the ad-hoc hooks approach most developers are using today.

### Risks and Gaps

1. **Trust calibration**: Teams are in a "trust calibration phase" with autonomous agents. DorkOS's approval flows must be polished and reliable, or they become the bottleneck rather than the safeguard.
2. **The PR-as-gate pattern is not yet in DorkOS**: Surfacing git diff / PR preview within the session UI would align DorkOS with how teams actually review autonomous agent output.
3. **Mobile notification for approvals is the highest-demand missing feature** in the ecosystem right now. DorkOS should prioritize this over other notification work.
4. **Context reconstruction** — developers need to re-orient to a session they haven't looked at in an hour. A "session briefing" feature (summarize what the agent has done) would address a documented pain point.

---

## Sources & Evidence

### Topic 1: Multi-Session Management
- [Orchestrate teams of Claude Code sessions - Claude Code Docs](https://code.claude.com/docs/en/agent-teams)
- [Multi-Agent Orchestration: Running 10+ Claude Instances in Parallel - DEV Community](https://dev.to/bredmond1019/multi-agent-orchestration-running-10-claude-instances-in-parallel-part-3-29da)
- [Embracing the parallel coding agent lifestyle - Simon Willison](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- [GitHub - smtg-ai/claude-squad: Manage multiple AI terminal agents](https://github.com/smtg-ai/claude-squad)
- [Parallel Workflows: Git Worktrees and Managing Multiple AI Agents - Medium](https://medium.com/@dennis.somerville/parallel-workflows-git-worktrees-and-the-art-of-managing-multiple-ai-agents-6fa3dc5eec1d)
- [LLM Codegen go Brrr: Parallelization with Git Worktrees and Tmux - DEV Community](https://dev.to/skeptrune/llm-codegen-go-brrr-parallelization-with-git-worktrees-and-tmux-2gop)
- [How we're shipping faster with Claude Code and Git Worktrees - incident.io](https://incident.io/blog/shipping-faster-with-claude-code-and-git-worktrees)
- [tmux Workflow for AI Coding Agents - Agent of Empires](https://www.agent-of-empires.com/guides/tmux-ai-coding-workflow/)
- [Building Mission Control for My AI Workforce: OpenClaw Command Center - Jonathan Tsai](https://www.jontsai.com/2026/02/12/building-mission-control-for-my-ai-workforce-introducing-openclaw-command-center)
- [2026 Agentic Coding Trends Report - Anthropic](https://resources.anthropic.com/2026-agentic-coding-trends-report)
- [8 trends shaping software engineering in 2026 - Tessl](https://tessl.io/blog/8-trends-shaping-software-engineering-in-2026-according-to-anthropics-agentic-coding-report/)

### Topic 2: Remote Agent Interaction
- [Continue local sessions from any device with Remote Control - Claude Code Docs](https://code.claude.com/docs/en/remote-control)
- [Claude Code Remote Control - Simon Willison](https://simonwillison.net/2026/Feb/25/claude-code-remote-control/)
- [Anthropic reveals Remote Control, a mobile version of Claude Code - TechRadar](https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move)
- [GitHub - RichardAtCT/claude-code-telegram: Remote access to Claude Code via Telegram](https://github.com/RichardAtCT/claude-code-telegram)
- [GitHub - JessyTsui/Claude-Code-Remote: Control Claude Code via email, discord, telegram](https://github.com/JessyTsui/Claude-Code-Remote)
- [Notify your iPhone or Watch when Claude Code finishes - Justin Searls](https://justin.searls.co/posts/notify-your-iphone-or-watch-when-claude-code-finishes/)
- [Claude Code Notifications: Get Alerts When Tasks Finish - alexop.dev](https://alexop.dev/posts/claude-code-notification-hooks/)
- [AI agents promise to work while you sleep. The reality is far messier - Fortune](https://fortune.com/2026/02/23/always-on-ai-agents-openclaw-claude-promise-work-while-sleeping-reality-problems-oversight-guardrails/)

### Topic 3: Autonomous Agent Scheduling
- [GitHub Copilot: Meet the new coding agent - GitHub Blog](https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/)
- [Copilot coding agent is now generally available - GitHub Community](https://github.com/orgs/community/discussions/159068)
- [Devin AI: The First Autonomous Software Engineer - Medium](https://medium.com/@mrabet_zakariae/the-devin-revolution-how-the-worlds-first-ai-software-engineer-is-changing-tech-forever-295a426ae229)
- [Meet Devin the AI Software Engineer, Employee #1 in Goldman Sachs' "Hybrid Workforce" - IBM](https://www.ibm.com/think/news/goldman-sachs-first-ai-employee-devin)
- [Agentic AI Security: New Dynamics, Trusted Foundations - CSA](https://cloudsecurityalliance.org/blog/2025/12/18/agentic-ai-security-new-dynamics-trusted-foundations)
- [How to Build Human-in-the-Loop Oversight for AI Agents - Galileo](https://galileo.ai/blog/human-in-the-loop-agent-oversight)
- [From Human-in-the-Loop to Human-on-the-Loop: Evolving AI Agent Autonomy - ByteBridge](https://bytebridge.medium.com/from-human-in-the-loop-to-human-on-the-loop-evolving-ai-agent-autonomy-c0ae62c3bf91)
- [The Agentic AI Security Scoping Matrix - AWS](https://aws.amazon.com/blogs/security/the-agentic-ai-security-scoping-matrix-a-framework-for-securing-autonomous-ai-systems/)
- [Lessons from 2025 on agents and trust - Google Cloud](https://cloud.google.com/transform/ai-grew-up-and-got-a-job-lessons-from-2025-on-agents-and-trust)

### Topic 4: Developer Notification Preferences
- [AI | 2025 Stack Overflow Developer Survey](https://survey.stackoverflow.co/2025/ai)
- [23% of Devs Regularly Use AI Agents - The New Stack](https://thenewstack.io/23-of-devs-regularly-use-ai-agents-per-stack-overflow-survey/)
- [Alert fatigue solutions for DevOps teams in 2025 - incident.io](https://incident.io/blog/alert-fatigue-solutions-for-dev-ops-teams-in-2025)
- [It's 2025 — Why Is Alert Fatigue Still Killing Your Flow? - Medium](https://ek121268.medium.com/its-2025-why-is-alert-fatigue-still-killing-your-flow-78ef93d201d5)
- [Claude Code Notifications via Hooks - alexop.dev](https://alexop.dev/posts/claude-code-notification-hooks/)
- [GitHub - dazuiba/CCNotify: Desktop notifications for Claude Code](https://github.com/dazuiba/CCNotify)
- [Step-by-Step Guide: Connect Telegram with Claude Code Hooks - Medium](https://medium.com/@dan.avila7/step-by-step-guide-connect-telegram-with-claude-code-hooks-1686fadcee65)
- [ntfy.sh: Push notifications via PUT/POST](https://ntfy.sh/)
- [Top 5 GitHub Slack Integrations in 2025 - Axolo](https://axolo.co/blog/p/top-5-github-pull-request-slack-integration)

---

## Research Gaps and Limitations

1. **No quantitative survey data on concurrent session counts**: The 4–20 range comes from anecdotal sources (blog posts, GitHub readmes). No formal survey has asked "how many concurrent agent sessions do you run?"
2. **Session duration statistics are sparse**: The documented examples (7 hours, 24+ hours, 1 week) are outliers. Median session length for typical developer workflows is not documented.
3. **Notification channel preference data is CI/CD-derived**: Developer notification preferences for agent-specific events have not been formally surveyed; the CI/CD analogy is the best available proxy.
4. **Anthropic's Remote Control is too new to assess adoption**: Launched February 24, 2026, no usage data is yet publicly available.
5. **Enterprise vs individual developer split is unclear**: Most evidence comes from individual power users. Enterprise team patterns (approval workflows, audit requirements) are less well-documented in public sources.

---

## Search Methodology

- **Searches performed**: ~20 targeted queries
- **Pages fetched**: ~12 primary sources
- **Most productive search terms**: `"parallel agents" git worktrees developer workflow`, `claude code notification hooks`, `claude code remote control`, `autonomous agent risks "runs while you sleep"`, `developer notification preferences CI/CD fatigue`
- **Primary source types**: Official documentation (Claude Code, GitHub Copilot), engineering blogs (incident.io, Simon Willison), GitHub repositories (star counts as demand signals), news coverage (Fortune, TechRadar, DevOps.com), academic/survey data (Stack Overflow 2025 Developer Survey)
- **Most reliable signal**: GitHub star counts on niche tools (1.8k stars on claude-code-telegram) provide strong demand evidence independent of editorial framing
