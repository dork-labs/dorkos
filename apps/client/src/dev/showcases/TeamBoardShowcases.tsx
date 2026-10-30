import { TeamBoardView, type TeamBoardData } from '@/layers/widgets/control-center';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const NOW = Date.now();
const MINUTE = 60_000;

const FIGURES: TeamBoardData['figures'] = [
  { key: 'chats', text: '4 of 14 chats running', over: false },
  { key: 'load', text: 'load 7', over: false },
  { key: 'disk', text: '24 GB free', over: false },
];

const BUSY: TeamBoardData = {
  figures: FIGURES,
  atCap: false,
  isEmpty: false,
  otherChats: [],
  rows: [
    {
      agent: { id: 'a', name: 'DorkOS Code', color: '#6366f1', emoji: '🛠️', projectPath: '/a' },
      running: 2,
      waiting: 1,
      chats: [
        {
          id: '1',
          cwd: '/a',
          title: 'Fix the login page',
          activity: 'Waiting',
          waiting: true,
          startedAt: NOW - 4 * MINUTE,
        },
        {
          id: '2',
          cwd: '/a',
          title: 'Team board',
          activity: 'Editing TeamBoard.tsx…',
          waiting: false,
          startedAt: NOW - 12 * MINUTE,
        },
        {
          id: '3',
          cwd: '/a',
          title: 'A very long chat title that has to shorten rather than wrap onto a second line',
          activity: 'Running tests…',
          waiting: false,
          startedAt: NOW - 125 * MINUTE,
        },
      ],
    },
    {
      agent: { id: 'b', name: 'DorkOS QA', color: '#10b981', emoji: '🔍', projectPath: '/b' },
      running: 1,
      waiting: 0,
      chats: [
        {
          id: '4',
          cwd: '/b',
          title: 'Release check',
          activity: 'Thinking…',
          waiting: false,
          startedAt: null,
        },
      ],
    },
    {
      agent: { id: 'c', name: 'Designer', color: '#f59e0b', emoji: '🎨', projectPath: '/c' },
      running: 0,
      waiting: 0,
      chats: [],
    },
  ],
};

const OVER: TeamBoardData = {
  ...BUSY,
  atCap: true,
  figures: [
    { key: 'chats', text: '14 of 14 chats running, at the limit', over: true },
    { key: 'load', text: 'load 18, limit 16', over: true },
    { key: 'disk', text: '12 GB free, limit 20 GB', over: true },
  ],
};

const NOTHING: TeamBoardData = {
  ...BUSY,
  isEmpty: true,
  rows: [],
  figures: [{ key: 'chats', text: '0 of 14 chats running', over: false }, ...FIGURES.slice(1)],
};

function Board({ board }: { board: TeamBoardData }) {
  return (
    <div className="max-w-sm">
      <TeamBoardView board={board} now={NOW} onOpenChat={() => {}} />
    </div>
  );
}

/** The Control Center's Team view in every state it can reach. */
export function TeamBoardShowcases() {
  return (
    <PlaygroundSection
      title="Team view"
      description="Control Center's Team view: who is running, who is waiting on you, and how much room is left."
    >
      <ShowcaseLabel>Running, waiting and idle</ShowcaseLabel>
      <ShowcaseDemo>
        <Board board={BUSY} />
      </ShowcaseDemo>

      <ShowcaseLabel>Every figure past its limit</ShowcaseLabel>
      <ShowcaseDemo>
        <Board board={OVER} />
      </ShowcaseDemo>

      <ShowcaseLabel>Nothing running</ShowcaseLabel>
      <ShowcaseDemo>
        <Board board={NOTHING} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
