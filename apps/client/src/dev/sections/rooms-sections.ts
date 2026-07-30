import type { PlaygroundSection } from '../playground-registry';

/**
 * Room component sections for the dev playground TOC and Cmd+K search.
 *
 * Section IDs must equal `slugify(title)` — verified by the playground-registry test suite.
 *
 * Sources: RoomsShowcases — Room Sheet, RoomMemberRow, ResponseModeControl,
 * LoudnessMeter, RoomLoudnessLine, AgentRosterPicker, RemoveMemberConfirm.
 */
export const ROOMS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'room-sheet',
    title: 'Room Sheet',
    page: 'rooms',
    category: 'Rooms',
    keywords: [
      'room',
      'sheet',
      'members',
      'roster',
      'channel',
      'dm',
      'direct message',
      'archived',
      'topic',
      'details',
    ],
  },
  {
    id: 'roommemberrow',
    title: 'RoomMemberRow',
    page: 'rooms',
    category: 'Rooms',
    keywords: ['member', 'row', 'roster', 'working', 'presence', 'avatar', 'agent', 'person'],
  },
  {
    id: 'responsemodecontrol',
    title: 'ResponseModeControl',
    page: 'rooms',
    category: 'Rooms',
    keywords: [
      'response mode',
      'rung',
      'loudness',
      'silent',
      'mention',
      'engaged',
      'everything',
      'radiogroup',
    ],
  },
  {
    id: 'loudnessmeter',
    title: 'LoudnessMeter',
    page: 'rooms',
    category: 'Rooms',
    keywords: ['loudness', 'meter', 'bars', 'level', 'dormant', 'scale'],
  },
  {
    id: 'roomloudnessline',
    title: 'RoomLoudnessLine',
    page: 'rooms',
    category: 'Rooms',
    keywords: ['loudness', 'room', 'line', 'sentence', 'preview', 'aggregate'],
  },
  {
    id: 'agentrosterpicker',
    title: 'AgentRosterPicker',
    page: 'rooms',
    category: 'Rooms',
    keywords: ['picker', 'chips', 'combobox', 'agents', 'add', 'fleet', 'search', 'typeahead'],
  },
  {
    id: 'removememberconfirm',
    title: 'RemoveMemberConfirm',
    page: 'rooms',
    category: 'Rooms',
    keywords: ['remove', 'confirm', 'undo', 'toast', 'member', 'destructive'],
  },
];
