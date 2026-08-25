import type { ComponentType } from 'react';
import { AnthropicLogo, CodexLogo, OpenCodeLogo } from '@dorkos/icons/adapter-logos';
import { JohnnyFiveFace, RosieFace, WalleFace, type FaceProps } from './avatars';

/** Stable key for each agent, used as a chat sender and layout id. */
export type AgentKey = 'rosie' | 'johnny' | 'walle';

/** A named agent in the demo fleet: one famous-robot face per runtime. */
export interface FleetAgent {
  /** Stable sender key used by the chat script. */
  key: AgentKey;
  /** The agent's name — famous, lovable robots. */
  name: string;
  /** Which coding-agent runtime powers it. */
  runtime: string;
  /** The agent's identity color, used to tint its avatar tile and name. */
  color: string;
  /** Cartoon face drawn in `avatars.tsx`. */
  Face: ComponentType<FaceProps>;
  /** Runtime brand mark for the avatar's corner sub-badge. */
  RuntimeLogo: ComponentType<{ size?: number; className?: string }>;
  /** Color the runtime mark renders in on the sub-badge. */
  runtimeColor: string;
}

/** The demo fleet: three famous robots, three runtimes, one chat. */
export const FLEET: readonly FleetAgent[] = [
  {
    key: 'rosie',
    name: 'Rosie',
    runtime: 'Claude Code',
    color: '#4fc7ce',
    Face: RosieFace,
    RuntimeLogo: AnthropicLogo,
    runtimeColor: '#d97757',
  },
  {
    key: 'johnny',
    name: 'Johnny 5',
    runtime: 'Codex',
    color: '#b0b3ba',
    Face: JohnnyFiveFace,
    RuntimeLogo: CodexLogo,
    runtimeColor: '#f5f0e6',
  },
  {
    key: 'walle',
    name: 'WALL·E',
    runtime: 'OpenCode',
    color: '#e8a33d',
    Face: WalleFace,
    RuntimeLogo: OpenCodeLogo,
    runtimeColor: '#4cc38a',
  },
];

/** Fleet agents keyed for direct lookup by sender. */
export const AGENTS_BY_KEY: Record<string, FleetAgent> = Object.fromEntries(
  FLEET.map((agent) => [agent.key, agent])
);
