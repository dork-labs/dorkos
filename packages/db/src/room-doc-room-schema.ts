/** Private literal schema metadata. Captured 3839 plus reviewed native request. */
import type { RoomDocExpectedTable } from './room-doc-schema.js';
export const roomSchema: Readonly<Record<string, RoomDocExpectedTable>> = {
  rooms: {
    columns: [
      ['id', 'TEXT', 1, 1, null],
      ['kind', 'TEXT', 1, 0, null],
      ['slug', 'TEXT', 0, 0, null],
      ['title', 'TEXT', 1, 0, null],
      ['topic', 'TEXT', 0, 0, null],
      ['archived', 'INTEGER', 1, 0, 'False'],
      ['ambient_max_entries', 'INTEGER', 1, 0, '30'],
      ['well_known', 'TEXT', 0, 0, null],
      ['fallback_seat_author_id', 'TEXT', 0, 0, null],
      ['turn_limits_enabled', 'INTEGER', 0, 0, null],
      ['max_agent_depth', 'INTEGER', 0, 0, null],
      ['max_turns_per_agent_per_cascade', 'INTEGER', 0, 0, null],
      ['max_auto_turns_per_hour', 'INTEGER', 0, 0, null],
      ['dm_member_key', 'TEXT', 0, 0, null],
      ['created_at', 'TEXT', 1, 0, null],
      ['last_activity_at', 'TEXT', 1, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'rooms_channel_slug_unique',
        'CREATE UNIQUE INDEX rooms_channel_slug_unique ON rooms (slug) WHERE "kind" = \'channel\' AND "archived" = 0',
      ],
      [
        'rooms_well_known_unique',
        'CREATE UNIQUE INDEX rooms_well_known_unique ON rooms (well_known)',
      ],
      [
        'rooms_dm_member_key_unique',
        'CREATE UNIQUE INDEX rooms_dm_member_key_unique ON rooms (dm_member_key) WHERE "kind" = \'dm\' AND "dm_member_key" IS NOT NULL',
      ],
    ],
  },
  authors: {
    columns: [
      ['id', 'TEXT', 1, 1, null],
      ['kind', 'TEXT', 1, 0, null],
      ['natural_key', 'TEXT', 1, 0, null],
      ['display_name', 'TEXT', 1, 0, null],
      ['handle', 'TEXT', 0, 0, null],
      ['emoji', 'TEXT', 0, 0, null],
      ['color', 'TEXT', 0, 0, null],
      ['image_url', 'TEXT', 0, 0, null],
      ['minted_for_manifest_id', 'TEXT', 0, 0, null],
      ['linked_owner_key', 'TEXT', 0, 0, null],
      ['retired_at', 'TEXT', 0, 0, null],
      ['created_at', 'TEXT', 1, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'authors_kind_natural_key_unique',
        'CREATE UNIQUE INDEX authors_kind_natural_key_unique ON authors (kind,natural_key) WHERE "retired_at" is null',
      ],
      [
        'authors_handle_unique',
        'CREATE UNIQUE INDEX authors_handle_unique ON authors (lower("handle")) WHERE "handle" is not null',
      ],
    ],
  },
  agents: {
    columns: [
      ['id', 'TEXT', 1, 1, null],
      ['name', 'TEXT', 1, 0, null],
      ['display_name', 'TEXT', 0, 0, null],
      ['runtime', 'TEXT', 1, 0, null],
      ['project_path', 'TEXT', 1, 0, null],
      ['namespace', 'TEXT', 1, 0, "'default'"],
      ['capabilities_json', 'TEXT', 1, 0, "'[]'"],
      ['entrypoint', 'TEXT', 0, 0, null],
      ['version', 'TEXT', 0, 0, null],
      ['description', 'TEXT', 0, 0, null],
      ['approver', 'TEXT', 0, 0, null],
      ['status', 'TEXT', 1, 0, "'active'"],
      ['scan_root', 'TEXT', 1, 0, "''"],
      ['behavior_json', 'TEXT', 1, 0, '\'{"responseMode":"always"}\''],
      ['last_seen_at', 'TEXT', 0, 0, null],
      ['last_seen_event', 'TEXT', 0, 0, null],
      ['persona', 'TEXT', 0, 0, null],
      ['persona_enabled', 'INTEGER', 1, 0, 'True'],
      ['traits_json', 'TEXT', 0, 0, null],
      ['conventions_json', 'TEXT', 0, 0, null],
      ['is_system', 'INTEGER', 1, 0, 'False'],
      ['color', 'TEXT', 0, 0, null],
      ['icon', 'TEXT', 0, 0, null],
      ['model', 'TEXT', 0, 0, null],
      ['effort', 'TEXT', 0, 0, null],
      ['account', 'TEXT', 0, 0, null],
      ['registered_at', 'TEXT', 1, 0, null],
      ['updated_at', 'TEXT', 1, 0, null],
      ['reports_to', 'TEXT', 0, 0, null],
      ['created_by', 'TEXT', 0, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'agents_project_path_unique',
        'CREATE UNIQUE INDEX agents_project_path_unique ON agents (project_path)',
      ],
    ],
  },
  room_members: {
    columns: [
      ['room_id', 'TEXT', 1, 1, null],
      ['author_id', 'TEXT', 1, 2, null],
      ['response_mode', 'TEXT', 1, 0, null],
      ['joined_at', 'TEXT', 1, 0, null],
      ['joined_seq', 'INTEGER', 1, 0, '0'],
      ['last_read_seq', 'INTEGER', 1, 0, '0'],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'idx_room_members_author',
        'CREATE INDEX idx_room_members_author ON room_members (author_id)',
      ],
    ],
  },
  room_sessions: {
    columns: [
      ['room_id', 'TEXT', 1, 1, null],
      ['author_id', 'TEXT', 1, 2, null],
      ['session_id', 'TEXT', 1, 0, null],
      ['created_at', 'TEXT', 1, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'idx_room_sessions_session',
        'CREATE INDEX idx_room_sessions_session ON room_sessions (session_id)',
      ],
    ],
  },
  room_session_retirements: {
    columns: [
      ['retired_session_id', 'TEXT', 1, 1, null],
      ['canonical_session_id', 'TEXT', 1, 0, null],
      ['retired_at', 'INTEGER', 1, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'idx_room_session_retirements_at',
        'CREATE INDEX idx_room_session_retirements_at ON room_session_retirements (retired_at)',
      ],
    ],
  },
  community_room_mirrors: {
    columns: [
      ['local_room_id', 'TEXT', 1, 1, null],
      ['community_ref', 'TEXT', 1, 0, null],
      ['remote_room_id', 'TEXT', 1, 0, null],
      ['owner_author_id', 'TEXT', 1, 0, null],
      ['state', 'TEXT', 1, 0, null],
      ['authorized_at', 'TEXT', 1, 0, null],
      ['redaction_cursor', 'TEXT', 0, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'community_room_mirrors_ref_remote_room_unique',
        'CREATE UNIQUE INDEX community_room_mirrors_ref_remote_room_unique ON community_room_mirrors (community_ref,remote_room_id)',
      ],
      [
        'idx_community_room_mirrors_owner_state',
        'CREATE INDEX idx_community_room_mirrors_owner_state ON community_room_mirrors (owner_author_id,state)',
      ],
    ],
  },
  room_entries: {
    columns: [
      ['room_id', 'TEXT', 1, 1, null],
      ['seq', 'INTEGER', 1, 2, null],
      ['id', 'TEXT', 1, 0, null],
      ['author_id', 'TEXT', 1, 0, null],
      ['kind', 'TEXT', 1, 0, null],
      ['body', 'TEXT', 1, 0, null],
      ['mentions', 'TEXT', 1, 0, "'[]'"],
      ['mention_spans', 'TEXT', 1, 0, "'[]'"],
      ['session_id', 'TEXT', 0, 0, null],
      ['cascade_root', 'TEXT', 1, 0, null],
      ['cascade_depth', 'INTEGER', 1, 0, '0'],
      ['dispatch_id', 'TEXT', 0, 0, null],
      ['parent_entry_id', 'TEXT', 0, 0, null],
      ['thread_root_entry_id', 'TEXT', 0, 0, null],
      ['signature', 'TEXT', 0, 0, null],
      ['created_at', 'TEXT', 1, 0, null],
      ['timeline_band', 'INTEGER', 0, 0, null],
      ['timeline_pos', 'INTEGER', 0, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      [
        'idx_room_entries_mirror_timeline',
        'CREATE INDEX idx_room_entries_mirror_timeline ON room_entries (room_id,timeline_band,timeline_pos) WHERE "timeline_band" IS NOT NULL',
      ],
      [
        'room_entries_room_id_entry_id_unique',
        'CREATE UNIQUE INDEX room_entries_room_id_entry_id_unique ON room_entries (room_id,id)',
      ],
      [
        'idx_room_entries_cascade_root',
        'CREATE INDEX idx_room_entries_cascade_root ON room_entries (room_id,cascade_root)',
      ],
      [
        'idx_room_entries_thread_root',
        'CREATE INDEX idx_room_entries_thread_root ON room_entries (room_id,thread_root_entry_id,seq) WHERE "thread_root_entry_id" IS NOT NULL',
      ],
      [
        'idx_room_entries_author_room',
        'CREATE INDEX idx_room_entries_author_room ON room_entries (author_id,room_id,thread_root_entry_id)',
      ],
      [
        'idx_room_entries_global_root',
        'CREATE INDEX idx_room_entries_global_root ON room_entries (id,room_id) WHERE id=cascade_root',
      ],
      [
        'idx_room_entries_global_descendants',
        'CREATE INDEX idx_room_entries_global_descendants ON room_entries (cascade_root,room_id,id)',
      ],
    ],
  },
  room_turn_spend: {
    columns: [
      ['id', 'INTEGER', 1, 1, null],
      ['room_id', 'TEXT', 1, 0, null],
      ['at', 'INTEGER', 1, 0, null],
    ],
    foreignKeys: [],
    checks: [],
    indices: [
      ['idx_room_turn_spend_at', 'CREATE INDEX idx_room_turn_spend_at ON room_turn_spend (at)'],
    ],
  },
};
