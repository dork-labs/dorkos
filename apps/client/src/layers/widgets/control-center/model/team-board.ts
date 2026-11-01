/**
 * The Team view's shape and its pure rules: who sorts where, and which figure
 * has passed its limit. No React and no store, so the data source can change
 * (DOR-3460's server list) without touching any of this.
 *
 * @module widgets/control-center/model/team-board
 */

/** Load at or past this is amber. */
export const LOAD_LIMIT = 16;
/** Free disk under this is amber. */
export const FREE_DISK_LIMIT_BYTES = 20 * 1024 ** 3;

/** One chat that is running or waiting on a person. */
export interface TeamBoardChat {
  id: string;
  cwd: string;
  title: string;
  /** What it is doing, in one line. */
  activity: string;
  waiting: boolean;
  /** When the chat started running (epoch ms), or `null` when nothing says. */
  startedAt: number | null;
}

/** An agent the board has a row for. */
export interface TeamBoardAgent {
  id: string;
  name: string;
  color: string;
  emoji: string;
  projectPath: string;
}

/** One row on the board, with its chats. */
export interface TeamBoardRow {
  agent: TeamBoardAgent;
  running: number;
  waiting: number;
  chats: TeamBoardChat[];
}

/** The computer's figures, each `null` until it can be read. */
export interface TeamBoardCapacity {
  maxAgentChats: number | null;
  loadAverage: number | null;
  freeDiskBytes: number | null;
}

/** One figure in the top line. */
export interface TeamBoardFigure {
  key: 'chats' | 'load' | 'disk';
  text: string;
  /** Past its limit: drawn amber, and `text` names the limit. */
  over: boolean;
}

/**
 * Group chats under their agents and sort: needs you first, then running, then
 * idle, by name within each. A chat in no agent's folder is left out here and
 * counted by the caller's total, which is why {@link unclaimedChats} exists.
 *
 * @param agents - Every registered agent.
 * @param chats - Every live chat.
 */
export function buildTeamRows(agents: TeamBoardAgent[], chats: TeamBoardChat[]): TeamBoardRow[] {
  const rows = agents.map((agent) => {
    const own = chats.filter((chat) => chat.cwd === agent.projectPath);
    const waiting = own.filter((chat) => chat.waiting).length;
    return { agent, running: own.length - waiting, waiting, chats: sortChats(own) };
  });
  return rows.sort((a, b) => rowRank(a) - rowRank(b) || a.agent.name.localeCompare(b.agent.name));
}

/**
 * Chats no registered agent claims by folder (a chat in a worktree, say). They
 * still count, so the board's total never disagrees with its rows.
 *
 * @param agents - Every registered agent.
 * @param chats - Every live chat.
 */
export function unclaimedChats(agents: TeamBoardAgent[], chats: TeamBoardChat[]): TeamBoardChat[] {
  const paths = new Set(agents.map((agent) => agent.projectPath));
  return sortChats(chats.filter((chat) => !paths.has(chat.cwd)));
}

function sortChats(chats: TeamBoardChat[]): TeamBoardChat[] {
  return [...chats].sort(
    (a, b) => Number(b.waiting) - Number(a.waiting) || a.title.localeCompare(b.title)
  );
}

function rowRank(row: TeamBoardRow): number {
  if (row.waiting > 0) return 0;
  return row.running > 0 ? 1 : 2;
}

/**
 * The top line's figures. One the server could not read is left out rather than
 * guessed; one past its limit names the limit in words, so colour is never the
 * only signal.
 *
 * @param runningChats - Chats running right now, waiting ones included.
 * @param capacity - The computer's figures.
 */
export function teamBoardFigures(
  runningChats: number,
  capacity: TeamBoardCapacity
): TeamBoardFigure[] {
  const { maxAgentChats, loadAverage, freeDiskBytes } = capacity;
  const figures: TeamBoardFigure[] = [];

  if (maxAgentChats === null) {
    figures.push({ key: 'chats', text: `${runningChats} chats running`, over: false });
  } else {
    const over = runningChats >= maxAgentChats;
    const count = `${runningChats} of ${maxAgentChats} chats running`;
    figures.push({ key: 'chats', text: over ? `${count}, at the limit` : count, over });
  }

  if (loadAverage !== null) {
    const load = Math.round(loadAverage);
    const over = loadAverage >= LOAD_LIMIT;
    figures.push({
      key: 'load',
      text: over ? `load ${load}, limit ${LOAD_LIMIT}` : `load ${load}`,
      over,
    });
  }

  if (freeDiskBytes !== null) {
    const free = Math.floor(freeDiskBytes / 1024 ** 3);
    const over = freeDiskBytes < FREE_DISK_LIMIT_BYTES;
    const limit = FREE_DISK_LIMIT_BYTES / 1024 ** 3;
    figures.push({
      key: 'disk',
      text: over ? `${free} GB free, limit ${limit} GB` : `${free} GB free`,
      over,
    });
  }

  return figures;
}

/**
 * The count beside an agent's name.
 *
 * @param row - The agent's row.
 */
export function teamRowCount(row: Pick<TeamBoardRow, 'running' | 'waiting'>): string {
  const parts: string[] = [];
  if (row.running > 0) parts.push(`${row.running} running`);
  if (row.waiting > 0) parts.push(`${row.waiting} waiting on you`);
  return parts.length > 0 ? parts.join(' · ') : 'Idle';
}

/**
 * How long a chat has been going, in the largest units that matter: `45s`,
 * `12m`, `2h 5m`.
 *
 * @param ms - Elapsed milliseconds.
 */
export function formatRunningFor(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
