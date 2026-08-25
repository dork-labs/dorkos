export interface VillainCard {
  id: string;
  label: string;
  body: string;
  solution: string;
}

export const villainCards: VillainCard[] = [
  {
    id: 'tab-graveyard',
    label: 'Every agent is in a different window.',
    body: 'Claude Code in one window. Codex in another. OpenCode in a third. Two projects, five terminals, and you’re the only thing that knows what any of them are doing.\n\nYou didn’t mean to become the router. It just happened.',
    solution: 'What if one place knew about all of them?',
  },
  {
    id: 'vendor-bet',
    label: 'Your whole workflow is a bet on one vendor.',
    body: 'One price change, one outage, one model that quietly got worse. Everything you’ve built around that one CLI is hostage to it.\n\nYou didn’t choose lock-in. It just built up.',
    solution: 'What if switching agents was a dropdown, not a migration?',
  },
  {
    id: 'stuck-waiting',
    label: 'Your agent is stuck waiting for you.',
    body: '“Can I edit this file?” It asked at 12:10. You were at lunch. It’s 12:50, and the smartest coding tool you own has spent forty minutes doing nothing.',
    solution: 'What if you could tap Approve from your phone?',
  },
];
