export interface VillainCard {
  id: string
  label: string
  body: string
}

export const villainCards: VillainCard[] = [
  {
    id: 'dead-terminal',
    label: 'The Dead Terminal',
    body: 'Your agent finished at 11:47pm. Clean code. Tests passing. Ready for you to look at. Then the terminal closed. The work sat there for three days until you found it by accident.\n\nYour best teammate shipped \u2014 and had no way to tell you.',
  },
  {
    id: 'goldfish',
    label: 'The Goldfish',
    body: '\u201CLet me give you some context\u2026\u201D\n\nYou have typed this sentence four hundred times. Every session begins at zero. Every session, you re-introduce yourself to something that was brilliant five minutes ago.',
  },
  {
    id: 'tab-graveyard',
    label: 'The Tab Graveyard',
    body: 'Ten agents. Ten terminals. One of them is waiting for approval. One finished twenty minutes ago. One broke something. You are jumping between them like a stressed-out air traffic controller who also has to fly the planes.',
  },
  {
    id: '3am-build',
    label: 'The 3am Build',
    body: 'Tests broke at 2:47am. The fix was three lines of code. Your agent knew exactly what to do. Your terminal was closed. The build stayed red until morning.',
  },
]
