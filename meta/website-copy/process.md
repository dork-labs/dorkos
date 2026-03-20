# Website Copy Development Process

## The Panel

Five personas from advertising, product, and design history serve as creative agents. Each brings a distinct lens. All receive the same brief and prompt per round.

| Agent      | Real Person  | Lens                                                  | Role                                           |
| ---------- | ------------ | ----------------------------------------------------- | ---------------------------------------------- |
| **Ogilvy** | David Ogilvy | Research-driven copy, headlines, long-form persuasion | The Craftsman — writes the actual words        |
| **Jobs**   | Steve Jobs   | Product narrative, simplicity, keynote story arcs     | The Narrator — shapes the story                |
| **Godin**  | Seth Godin   | Positioning, tribes, "who is this for"                | The Strategist — sharpens who we're talking to |
| **Ive**    | Jony Ive     | Design language, material honesty, sensory feel       | The Aesthetic — how it feels, not just reads   |
| **Wieden** | Dan Wieden   | Emotional gut-punch, identity-level branding          | The Provocateur — the line you can't forget    |

## How It Works

### Structure

```
meta/website-copy/
├── process.md              # This file — the repeatable process
├── brief/
│   └── creative-brief.md   # The brief all agents work from
├── rounds/
│   ├── 01-big-idea/
│   │   ├── prompt.md       # What we asked the panel
│   │   ├── ogilvy.md       # David Ogilvy's response
│   │   ├── jobs.md         # Steve Jobs' response
│   │   ├── godin.md        # Seth Godin's response
│   │   ├── ive.md          # Jony Ive's response
│   │   ├── wieden.md       # Dan Wieden's response
│   │   └── synthesis.md    # Orchestrator's synthesis
│   ├── 02-homepage/
│   ├── 03-pages/
│   └── ...
├── drafts/
│   ├── v1/                 # First complete draft
│   └── v2/                 # Revised draft
└── decisions.md            # Key decisions log
```

### Round Workflow

1. **Orchestrator writes `prompt.md`** — a focused question or task for the round, referencing the creative brief and any prior round synthesis
2. **5 agents run in parallel** — each receives the creative brief + prompt + all prior synthesis files. Each writes their response as `{agent}.md` in the round folder
3. **Orchestrator writes `synthesis.md`** — pulls the best threads from all 5 responses into a unified direction
4. **User reviews synthesis** — approves, revises, or redirects
5. **Next round begins**

### Agent Prompting Pattern

Each agent receives:

- The full creative brief (`brief/creative-brief.md`)
- The round prompt (`rounds/NN-topic/prompt.md`)
- All prior synthesis files (from completed rounds)
- Their persona identity and lens description

Each agent produces a markdown file with their response. The response should be in character — reflecting the agent's historical thinking style, vocabulary, and priorities.

### Orchestrator Role

The orchestrator (Claude) does NOT contribute creative opinions. It:

- Writes prompts that are clear and focused
- Runs agents in parallel
- Synthesizes responses without adding its own ideas
- Presents the synthesis to the user for approval
- Tracks decisions in `decisions.md`

## When to Use This Process

This process works for any creative work that benefits from multiple expert perspectives:

- Website copy
- Product naming
- Brand campaigns
- Pitch decks
- Launch announcements
- Manifesto / about page writing

## Adapting the Panel

The panel can be swapped for different creative challenges:

- **Technical documentation**: Knuth, Tufte, Strunk & White
- **Product strategy**: Cagan, Horowitz, Ries
- **Visual design**: Rams, Sagmeister, Müller-Brockmann

The structure stays the same. Only the personas change.
