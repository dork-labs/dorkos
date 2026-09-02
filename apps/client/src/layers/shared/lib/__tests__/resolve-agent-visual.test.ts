import { describe, it, expect } from 'vitest';
import { seedAgentFace, AGENT_COLOR_PRESETS, AGENT_EMOJI_SET } from '@dorkos/shared/agent-face';
import { resolveAgentVisual } from '../resolve-agent-visual';

describe('resolveAgentVisual', () => {
  it('uses color and icon overrides when present', () => {
    const result = resolveAgentVisual({ id: 'test-id', color: '#6366f1', icon: '🤖' });
    expect(result.color).toBe('#6366f1');
    expect(result.emoji).toBe('🤖');
  });

  // The fallback is the face the SERVER seeds for this id (DOR-949), not a
  // second hash of the resolver's own. Red when the two drift apart, which is
  // the bug this replaced: the server wrote a palette hex and this handed back
  // an HSL hue, so clearing an override changed the agent's colour.
  it('falls back to the face DorkOS seeds for that id', () => {
    const result = resolveAgentVisual({ id: 'test-id' });
    expect(result.color).toBe(seedAgentFace('test-id').color);
    expect(result.emoji).toBe(seedAgentFace('test-id').icon);
    expect(AGENT_COLOR_PRESETS.map((preset) => preset.hex)).toContain(result.color);
    expect(AGENT_EMOJI_SET).toContain(result.emoji);
  });

  it('handles partial overrides — color set, icon not', () => {
    const result = resolveAgentVisual({ id: 'test-id', color: '#ff0000' });
    expect(result.color).toBe('#ff0000');
    expect(result.emoji).toBe(seedAgentFace('test-id').icon);
  });

  it('handles partial overrides — icon set, color not', () => {
    const result = resolveAgentVisual({ id: 'test-id', icon: '🎯' });
    expect(result.color).toBe(seedAgentFace('test-id').color);
    expect(result.emoji).toBe('🎯');
  });

  it('treats null overrides same as undefined (defensive against runtime data)', () => {
    const result = resolveAgentVisual({ id: 'test-id', color: null, icon: null });
    expect(result).toEqual({
      color: seedAgentFace('test-id').color,
      emoji: seedAgentFace('test-id').icon,
    });
  });

  it('produces same output for same id', () => {
    const a = resolveAgentVisual({ id: 'stable-id' });
    const b = resolveAgentVisual({ id: 'stable-id' });
    expect(a).toEqual(b);
  });
});
