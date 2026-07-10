export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

export const faqItems: FaqItem[] = [
  {
    id: 'what-is-agent',
    question: 'What do you mean by "agent"?',
    answer:
      "An agent is an AI coding tool, like Claude Code, Codex, or OpenCode, that can read, write, and run code on your machine. DorkOS doesn't replace your agents. It gives them what they're missing to work when you're not watching: a schedule, a way to reach you, a record of everything they did, and a way to find and message each other.",
  },
  {
    id: 'how-different-from-claude-code',
    question: 'How is this different from just using Claude Code?',
    answer:
      'Claude Code is the agent: the tool that thinks and writes code. DorkOS is the system around it. Without DorkOS, your agent stops the moment you close the terminal. With it, your agents run on a schedule, message you when something breaks, message each other, and pick up right where they left off.',
  },
  {
    id: 'data-privacy',
    question: 'Does DorkOS send any data to external servers?',
    answer:
      "No. DorkOS runs entirely on your own computer. Your session data stays on your machine, in each AI tool's own local files. There are no accounts, no cloud dependency, and nothing phoning home to check in.",
  },
  {
    id: 'getting-started',
    question: 'What do I need to get started?',
    answer:
      "Node.js 18 or newer, and at least one supported coding agent: Claude Code, Codex, or OpenCode. Claude Code comes bundled with DorkOS, so it's the fastest way to start. One command installs DorkOS. No DorkOS account to create, no cloud services to configure. If you can run `npm install`, you're ready.",
  },
  {
    id: 'license',
    question: 'What license is DorkOS under?',
    answer:
      'MIT (an open license with almost no restrictions). Use it commercially, fork it, modify it, ship it.',
  },
  {
    id: 'remote-server',
    question: 'Can I run DorkOS on a remote server?',
    answer:
      'Yes. DorkOS runs wherever you put it: your laptop, a home server, or a cheap cloud box. Built-in tunnel support lets you reach it from anywhere.',
  },
  {
    id: 'cost',
    question: 'Is DorkOS free?',
    answer:
      "DorkOS is free and open source. Running the agents themselves costs a little, since they call out to whichever AI company powers them; a night of work might run a few dollars. DorkOS doesn't add anything on top.",
  },
];
