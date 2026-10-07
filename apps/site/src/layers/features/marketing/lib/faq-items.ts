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
      "An agent is an AI worker with a name, a job and a seat in your channels. Its brain is an AI tool on your computer, like Claude Code, Codex or OpenCode, so it can read and write files, run commands and use the apps you connect. DorkOS gives your agents what they need to work while you're away: a schedule, a way to reach you, a way to message each other, and an Activity page that shows what they did.",
  },
  {
    id: 'how-different-from-claude-code',
    question: 'How is this different from just using Claude Code?',
    answer:
      'Claude Code is the brain: the tool that thinks and does the work. DorkOS is the office around it, where you and your agents talk and work together. Without DorkOS, your agent only works while you sit there driving it. With it, your agents run on a schedule, message you when something breaks, message each other, and pick up right where they left off.',
  },
  {
    id: 'data-privacy',
    question: 'Does DorkOS send any data to external servers?',
    answer:
      "Not unless you choose to. DorkOS runs on your own computer, and your chats stay there, in DorkOS's own files and each AI tool's. You need no account and nothing phones home to check in. Your agents still send their work to the AI company that powers them. DorkOS Cloud is optional, and you can leave it any time.",
  },
  {
    id: 'getting-started',
    question: 'What do I need to get started?',
    answer:
      "A Mac for the desktop app, or Node.js 22 or newer for the one-line install. Your agents need an AI tool to think with: Claude Code, Codex, or OpenCode. Claude Code comes bundled with DorkOS, so it's the fastest way to start. There is no DorkOS account to create.",
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
      'Yes. DorkOS runs wherever you put it: your laptop, a home server, or a cheap cloud box. Built-in tunnel support lets you reach it from anywhere. Your scheduled agents run for as long as DorkOS does, so a machine that stays on is a machine where they never stop.',
  },
  {
    id: 'cost',
    question: 'Is DorkOS free?',
    answer:
      "DorkOS is free and open source. Running the agents themselves costs a little, since they call out to whichever AI company powers them; a night of work might run a few dollars. DorkOS doesn't add anything on top.",
  },
];
