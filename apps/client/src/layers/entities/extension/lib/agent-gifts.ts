/**
 * What an extension gives agents — its tools and skills — in the one shape the
 * Settings card and the Activity inbox row both draw (DOR-2685).
 *
 * The two read different wire shapes: the card reads `GET /api/extensions`
 * (each tool's live status), the inbox row reads the pending-approval list
 * (what discovery decided before any code ran). Both reduce to this, so the
 * two places a person decides about an extension say the same thing.
 *
 * @module entities/extension/lib/agent-gifts
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';

/** A tool's permission tier. */
export type AgentToolTier = 'observe' | 'act' | 'destructive';

/** One tool an extension declares. */
export interface AgentGiftTool {
  /** The tool's name inside the extension, e.g. `send_message`. */
  name: string;
  /** The title a person reads. Shown only for an accepted tool. */
  title: string;
  /** Its permission tier. */
  tier: AgentToolTier;
  /** Why DorkOS refused it, when it did. */
  leftOutReason?: string;
}

/** One skill an extension declares. */
export interface AgentGiftSkill {
  /** The skill's folder name. */
  name: string;
  /** Why it is left out, when it is. */
  leftOutReason?: string;
}

/** Every tool and skill an extension declares, in manifest order. */
export interface AgentGifts {
  tools: AgentGiftTool[];
  skills: AgentGiftSkill[];
  /**
   * Whether the extension runs now, so its agents have these. When it does
   * not (off, waiting for approval, broken), the line says "Would give".
   */
  running: boolean;
}

/** Statuses of an extension whose code is running or on its way to running. */
const RUNNING_STATUSES = new Set(['enabled', 'compiled', 'active']);

/** What each tier means for a person, as one word or phrase. */
export const AGENT_TOOL_TIER_LABEL: Record<AgentToolTier, string> = {
  observe: 'Reads',
  act: 'Acts',
  destructive: 'Asks you first',
};

/**
 * Read an extension's tools and skills from its `GET /api/extensions` record.
 *
 * @param extension - The public record.
 */
export function agentGiftsFromRecord(
  extension: Pick<ExtensionRecordPublic, 'tools' | 'skills' | 'status' | 'approvedToRun'>
): AgentGifts {
  return {
    running: extension.approvedToRun && RUNNING_STATUSES.has(extension.status),
    tools: (extension.tools ?? []).map((tool) => ({
      name: tool.name,
      title: tool.title,
      tier: tool.tier,
      ...(tool.status === 'refused' ? { leftOutReason: tool.reason ?? 'DorkOS refused it.' } : {}),
    })),
    skills: (extension.skills ?? []).map((skill) => ({
      name: skill.name,
      ...(skill.status === 'dropped'
        ? { leftOutReason: skill.reason ?? 'DorkOS left it out.' }
        : {}),
    })),
  };
}

/**
 * Read an extension's tools and skills from its pending-approval row.
 *
 * @param approval - The waiting extension.
 */
export function agentGiftsFromApproval(
  approval: Pick<PendingExtensionApproval, 'agentTools' | 'agentSkills'>
): AgentGifts {
  return {
    // Waiting for a yes, so none of it runs yet.
    running: false,
    tools: approval.agentTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      tier: tool.tier,
      ...(tool.refusedReason !== undefined ? { leftOutReason: tool.refusedReason } : {}),
    })),
    skills: approval.agentSkills.map((skill) => ({
      name: skill.name,
      ...(skill.droppedReason !== undefined ? { leftOutReason: skill.droppedReason } : {}),
    })),
  };
}

/** "1 tool", "3 skills". */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The one line that sums it up: "Gives agents 3 tools and 1 skill" while the
 * extension runs, "Would give agents …" while it does not. Counts only what
 * reaches agents; a refused tool or a skill left out is listed with its
 * reason, never counted.
 *
 * @param gifts - What the extension declares, and whether it runs.
 * @returns The line, or `null` when it declares no tools and no skills.
 */
export function agentGiftsLine(gifts: AgentGifts): string | null {
  if (gifts.tools.length === 0 && gifts.skills.length === 0) return null;
  const verb = gifts.running ? 'Gives agents' : 'Would give agents';
  const tools = gifts.tools.filter((tool) => tool.leftOutReason === undefined).length;
  const skills = gifts.skills.filter((skill) => skill.leftOutReason === undefined).length;
  if (tools === 0 && skills === 0) return `${verb} no tools or skills`;
  const parts = [
    ...(tools > 0 ? [counted(tools, 'tool')] : []),
    ...(skills > 0 ? [counted(skills, 'skill')] : []),
  ];
  return `${verb} ${parts.join(' and ')}`;
}
