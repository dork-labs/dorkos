/**
 * Extensions that came in one plugin, as one row in Settings → Extensions
 * (DOR-3583). The group is the plugin that installed them (`sourcePlugin`),
 * never a field an extension writes about itself; a dev link and a copy with
 * no plugin stay on their own rows.
 *
 * Pure functions only, so the grouping and the row's words are tested without
 * drawing anything.
 *
 * @module features/extensions/lib/extension-groups
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { pluginDisplayName } from '@/layers/entities/extension';
import { extensionRowState, isExtensionOn, waitsForOk } from './extension-row-state';

/** One plugin's extensions, drawn as one row. */
export interface ExtensionGroup {
  /** The plugin that installed them. */
  plugin: string;
  /** The plugin's name as the row shows it ("marketing-suite" → "Marketing suite"). */
  name: string;
  /** Its members, A–Z. */
  members: ExtensionRecordPublic[];
}

/** Case-insensitive A–Z on the name. */
function byName(a: ExtensionRecordPublic, b: ExtensionRecordPublic): number {
  return a.manifest.name.localeCompare(b.manifest.name, undefined, { sensitivity: 'base' });
}

/**
 * Split the list into plugin groups (two or more installed members) and the
 * extensions that stay on their own rows.
 *
 * @param extensions - Every extension the server listed.
 */
export function groupExtensions(extensions: readonly ExtensionRecordPublic[]): {
  groups: ExtensionGroup[];
  loose: ExtensionRecordPublic[];
} {
  const byPlugin = new Map<string, ExtensionRecordPublic[]>();
  for (const ext of extensions) {
    if (ext.origin !== 'user' || ext.devLink || !ext.sourcePlugin) continue;
    byPlugin.set(ext.sourcePlugin, [...(byPlugin.get(ext.sourcePlugin) ?? []), ext]);
  }
  const groups: ExtensionGroup[] = [];
  const grouped = new Set<string>();
  for (const [plugin, members] of byPlugin) {
    if (members.length < 2) continue;
    groups.push({ plugin, name: pluginDisplayName(plugin), members: [...members].sort(byName) });
    for (const member of members) grouped.add(member.id);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { groups, loose: extensions.filter((ext) => !grouped.has(ext.id)) };
}

/** What a closed group row shows. */
export interface ExtensionGroupState {
  /** Members waiting for the person's OK. */
  waiting: number;
  /** Members allowed to run: the only ones the switch turns on or off. */
  allowed: ExtensionRecordPublic[];
  /** Whether the row sits under "Needs you". */
  needsYou: boolean;
  /** The one line under the name. */
  purpose: string;
  /** How many members need the person; the row's count pill. */
  needsYouCount: number;
  /** What that pill says to a screen reader ("1 needs you"), or null when none do. */
  chip: string | null;
  /** The switch's answer: some allowed member is on. */
  isOn: boolean;
}

/**
 * What the closed group row shows.
 *
 * @param group - The group.
 */
export function extensionGroupState(group: ExtensionGroup): ExtensionGroupState {
  const total = group.members.length;
  const waiting = group.members.filter(waitsForOk).length;
  const allowed = group.members.filter((member) => !waitsForOk(member));
  const needsYou = group.members.filter((member) => extensionRowState(member).needsYou).length;
  const purpose =
    waiting > 0
      ? `${total} extensions · ${allowed.length} of ${total} allowed`
      : `${total} extensions · ${group.members.map((member) => member.manifest.name).join(', ')}`;
  return {
    waiting,
    allowed,
    needsYou: needsYou > 0,
    purpose,
    needsYouCount: needsYou,
    chip: needsYou === 0 ? null : needsYou === 1 ? '1 needs you' : `${needsYou} need you`,
    isOn: allowed.some(isExtensionOn),
  };
}
