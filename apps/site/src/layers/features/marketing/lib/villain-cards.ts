export interface VillainCard {
  id: string;
  label: string;
  body: string;
  solution: string;
}

export const villainCards: VillainCard[] = [
  {
    id: 'tab-graveyard',
    label: 'The Tab Graveyard',
    body: 'Claude Code in one window. Codex in another. OpenCode in a third. Two projects, five terminals \u2014 and you\u2019re the only thing that knows what any of them are doing.\n\nYou didn\u2019t mean to become the router. It just happened.',
    solution: 'What if one place knew about all of them?',
  },
  {
    id: 'goldfish',
    label: 'The Goldfish',
    body: '\u201CLet me give you some context\u2026\u201D\n\nYou have typed this sentence hundreds of times. Every session begins at zero. Every session, you re-introduce yourself to something that was sharp and useful five minutes ago.',
    solution: 'What if you never had to say \u2018let me give you some context\u2019 again?',
  },
  {
    id: '3am-build',
    label: 'The 3am Crash',
    body: 'The app broke at 2:47am. The fix was three lines your agent could have written. Instead, you woke up to an angry inbox.',
    solution: 'Imagine your phone buzzing at 2:55am. Not with a problem. With a fix.',
  },
];
