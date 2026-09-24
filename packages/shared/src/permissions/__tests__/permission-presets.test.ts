/**
 * Pins every shipped preset value literally. A failure here means a shipped
 * preset changed, which needs a protective config migration first (copy the old
 * value into `permissions.defaults` for every install on that preset), so no
 * preset ever silently widens.
 */
import { describe, it, expect } from 'vitest';
import {
  PERMISSION_PRESET_TABLES,
  UNCHANGED_PERMISSION_TABLE,
  presetTableFor,
} from '../permission-presets.js';
import { PERMISSION_AREAS, isFloorArea } from '../permission-areas.js';
import { PERMISSION_AREA_IDS } from '../permission-schemas.js';

describe('shipped preset tables', () => {
  it('Careful', () => {
    expect(PERMISSION_PRESET_TABLES.careful).toEqual({
      areas: {
        rooms: 'ask',
        tasks: 'ask',
        agents: 'ask',
        messages: 'allowed',
        connections: 'ask',
        packages: 'ask',
        settings: 'ask',
        safety: 'ask',
        permissions: 'ask',
        reach: 'blocked',
      },
      actions: {},
      filesStop: 'ask',
    });
  });

  it('Balanced', () => {
    expect(PERMISSION_PRESET_TABLES.balanced).toEqual({
      areas: {
        rooms: 'allowed',
        tasks: 'ask',
        agents: 'ask',
        messages: 'allowed',
        connections: 'ask',
        packages: 'ask',
        settings: 'ask',
        safety: 'ask',
        permissions: 'ask',
        reach: 'ask',
      },
      actions: {},
      filesStop: 'act',
    });
  });

  it('Full power', () => {
    expect(PERMISSION_PRESET_TABLES.full).toEqual({
      areas: {
        rooms: 'allowed',
        tasks: 'allowed',
        agents: 'allowed',
        messages: 'allowed',
        connections: 'allowed',
        packages: 'ask',
        settings: 'ask',
        safety: 'ask',
        permissions: 'ask',
        reach: 'ask',
      },
      actions: {},
      filesStop: 'autonomy',
    });
  });

  it('Unchanged reproduces the behaviour before permissions existed', () => {
    // Rooms management was an off-by-default tool group (merge never was), the
    // floor areas were out of an agent's reach, everything else ran on its tier.
    expect(UNCHANGED_PERMISSION_TABLE).toEqual({
      areas: {
        rooms: 'blocked',
        tasks: 'allowed',
        agents: 'allowed',
        messages: 'allowed',
        connections: 'allowed',
        packages: 'allowed',
        settings: 'allowed',
        safety: 'blocked',
        permissions: 'blocked',
        reach: 'blocked',
      },
      actions: { 'rooms.merge': 'allowed' },
      filesStop: null,
    });
    expect(presetTableFor(null)).toBe(UNCHANGED_PERMISSION_TABLE);
  });

  it('no table ever sets a floor area to Allowed', () => {
    const tables = [...Object.values(PERMISSION_PRESET_TABLES), UNCHANGED_PERMISSION_TABLE];
    for (const table of tables) {
      for (const id of PERMISSION_AREA_IDS) {
        if (isFloorArea(id)) expect(table.areas[id]).not.toBe('allowed');
      }
    }
  });

  it('every table is frozen', () => {
    for (const table of [...Object.values(PERMISSION_PRESET_TABLES), UNCHANGED_PERMISSION_TABLE]) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(Object.isFrozen(table.areas)).toBe(true);
    }
  });
});

describe('area registry', () => {
  it('lists the ten state areas plus files, with exactly three floors', () => {
    expect(PERMISSION_AREAS.map((a) => a.id)).toEqual([...PERMISSION_AREA_IDS, 'files']);
    expect(PERMISSION_AREAS.filter((a) => a.floor).map((a) => a.id)).toEqual([
      'safety',
      'permissions',
      'reach',
    ]);
  });
});
