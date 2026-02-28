export interface TimelineEntry {
  id: string
  time: string
  headline: string
  paragraphs: string[]
}

export const timelineEntries: TimelineEntry[] = [
  {
    id: '1114pm',
    time: '11:14 PM',
    headline: 'You hand off three tasks. Then you close the laptop.',
    paragraphs: [
      'A test suite that needs expanding. A dependency upgrade across two services. A refactor you\u2019ve been putting off.',
      'You type one command. [PULSE] schedules all three.',
      'You close the laptop.',
    ],
  },
  {
    id: '1115pm',
    time: '11:15 PM',
    headline: 'The first agent starts before you finish brushing your teeth.',
    paragraphs: [
      'It reads the coverage report, identifies the gaps, starts writing tests.',
      'You are brushing your teeth.',
    ],
  },
  {
    id: '247am',
    time: '2:47 AM',
    headline: 'Something breaks. An agent fixes it. You never wake up.',
    paragraphs: [
      'Tests fail on the dependency upgrade. [PULSE] detects it. Dispatches an agent. The agent reads the error, traces the cause, opens a fix. Tests go green.',
      'Your phone buzzes once. A Telegram message from [RELAY]: \u201CTests were failing. Fixed. Change #247 ready for your review.\u201D',
      'You do not see it until morning.',
    ],
  },
  {
    id: '248am',
    time: '2:48 AM',
    headline: 'Two agents almost step on each other. They sort it out.',
    paragraphs: [
      'The agent that fixed the tests notices the other agent is working in the same service. [MESH] sends a heads-up \u2014 one waits for the other to merge first, avoiding a conflict.',
      'No human involved. No terminal open.',
    ],
  },
  {
    id: '700am',
    time: '7:00 AM',
    headline: 'You open your laptop to a full progress report.',
    paragraphs: [
      'You open your laptop. [CONSOLE] shows the night at a glance: three changes ready for review, one fix already merged, the refactor at 80% \u2014 waiting on a design question it queued for you. The overnight cost: $4.20.',
    ],
  },
  {
    id: '704am',
    time: '7:04 AM',
    headline: 'You\u2019ve been awake four minutes. Your team worked eight hours.',
    paragraphs: [
      'You approve two changes. You request a revision on the third. You queue two more tasks for the day.',
      'Your agents have been productive for eight hours. You have been awake for four minutes.',
    ],
  },
]
