export interface VillainCard {
  id: string
  label: string
  body: string
  solution: string
}

export const villainCards: VillainCard[] = [
  {
    id: 'goldfish',
    label: 'The Goldfish',
    body: '\u201CLet me give you some context\u2026\u201D\n\nYou have typed this sentence hundreds of times. Every session begins at zero. Every session, you re-introduce yourself to something that was sharp and useful five minutes ago.',
    solution: "What if you never had to say \u2018let me give you some context\u2019 again?",
  },
  {
    id: '3am-build',
    label: 'The 3am Crash',
    body: 'The app broke at 2:47am. The fix was three lines. Your agent could have written them. You woke up to an angry inbox.',
    solution: "Imagine your phone buzzing at 2:55am. Not with a problem. With a fix.",
  },
  {
    id: 'tab-graveyard',
    label: 'The Tab Graveyard',
    body: 'Ten agents. Ten terminals. One is waiting for approval. One finished twenty minutes ago. One is quietly breaking something.\n\nYou are the only thread between them.',
    solution: "What if you weren\u2019t the only thing holding it together?",
  },
  
]
