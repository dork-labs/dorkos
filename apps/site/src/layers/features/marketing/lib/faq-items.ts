export interface FaqItem {
  id: string
  question: string
  answer: string
}

export const faqItems: FaqItem[] = [
  {
    id: 'what-is-agent',
    question: 'What do you mean by "agent"?',
    answer: 'An agent is an AI coding tool — like Claude Code, Cursor, or Codex — that can read, write, and run code on your machine. DorkOS doesn\'t replace your agents. It gives them the infrastructure to work when you\'re not watching: scheduling, communication, memory, and coordination.',
  },
  {
    id: 'how-different-from-claude-code',
    question: 'How is this different from just using Claude Code?',
    answer: 'Claude Code is the agent — the thing that thinks and writes code. DorkOS is the system around it. Without DorkOS, your agent stops when you close the terminal. With it, your agents run on schedules, message you when something breaks, coordinate with each other, and pick up where they left off.',
  },
  {
    id: 'data-privacy',
    question: 'Does DorkOS send any data to external servers?',
    answer: 'No. DorkOS runs entirely on your hardware. Session data stays in Claude Code\'s local transcript files. There are no accounts, no cloud dependency, and no telemetry phoning home.',
  },
  {
    id: 'getting-started',
    question: 'What do I need to get started?',
    answer: 'Node.js 18+ and Claude Code. One command installs DorkOS. No accounts to create, no cloud services to configure. If you can run `npm install`, you\'re ready.',
  },
  {
    id: 'license',
    question: 'What license is DorkOS under?',
    answer: 'MIT. Use it commercially, fork it, modify it, ship it. No restrictions.',
  },
  {
    id: 'remote-server',
    question: 'Can I run DorkOS on a remote server?',
    answer: 'Yes. DorkOS runs wherever you put it — your laptop, a VPS, a Raspberry Pi, a cloud VM. Built-in tunnel support lets you access it from anywhere.',
  },
  {
    id: 'cost',
    question: 'Is DorkOS free?',
    answer: 'DorkOS is free and open source. The agents themselves use API credits from their providers — running Claude Code overnight might cost a few dollars depending on the work. DorkOS doesn\'t add any cost on top of that.',
  },
]
