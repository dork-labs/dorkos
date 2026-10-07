export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

export const faqItems: FaqItem[] = [
  {
    id: 'what-is-dorkos',
    question: 'What is DorkOS?',
    answer:
      'DorkOS is a workspace for people and agents. You and your AI agents talk in channels, DMs and threads, and the agents do real work on your computer. Ask for a tool your business needs, and your agents build it right inside DorkOS.',
  },
  {
    id: 'how-different',
    question: 'Lots of apps put agents in a chat now. How is DorkOS different?',
    answer:
      'Three things. First, mini apps: ask for a tool, like a dashboard or a tracker, and your agents build it. Once you say yes, it opens inside DorkOS. Second, it is built for founders, not for every kind of team. Third, it is yours: it runs on your computer, works in your real files, uses the AI plans you already pay for, and the code is open.',
  },
  {
    id: 'who-for',
    question: 'Who is DorkOS for?',
    answer:
      "Founders who run a big or complex business mostly with agents. You don't need to be a programmer, but you should be happy to install an app and sign in to an AI tool like Claude Code. Developers who run many agents across many projects use it too. Ready-made mini apps for founders are coming.",
  },
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
      'Claude Code is the brain: the tool that thinks and does the work. DorkOS is the office around it, where you and your agents talk and work together. Without DorkOS, your agent only works while you sit there driving it. With it, your agents run on a schedule, message you when something breaks, message each other, and build you mini apps that open inside DorkOS.',
  },
  {
    id: 'ownership',
    question: 'Who owns my data and my AI plans?',
    answer:
      "You do. DorkOS runs on your own computer, and your chats and files stay there, in DorkOS's own files and each AI tool's. Your agents think with your own Claude Code, Codex or OpenCode sign-in, so the plan you already pay for does the work. You need no DorkOS account. Nothing about you or your work goes to DorkOS. The app only checks for updates. Your agents still send their work to the AI company that powers them. DorkOS Cloud is optional, and you can leave it any time.",
  },
  {
    id: 'cost',
    question: 'Is DorkOS free?',
    answer:
      "Yes. DorkOS is free and open source under the MIT license (an open license with almost no restrictions), and free forever on your computer. Running the agents themselves costs a little, since they call out to whichever AI company powers them; a night of work might run a few dollars. DorkOS doesn't add anything on top.",
  },
  {
    id: 'getting-started',
    question: 'What do I need to get started?',
    answer:
      "A Mac for the desktop app, or Node.js 22 or newer for the one-line install. Your agents need an AI tool to think with: Claude Code, Codex, or OpenCode. Claude Code comes bundled with DorkOS, so it's the fastest way to start. There is no DorkOS account to create.",
  },
  {
    id: 'remote-server',
    question: 'Can I run DorkOS on a remote server?',
    answer:
      'Yes. DorkOS runs wherever you put it: your laptop, a home server, or a cheap cloud box. Built-in tunnel support lets you reach it from anywhere. Your scheduled agents run for as long as DorkOS does, so a machine that stays on is a machine where they never stop.',
  },
];
