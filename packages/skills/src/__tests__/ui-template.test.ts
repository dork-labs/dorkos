import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WidgetTemplateSchema } from '../ui-template.js';

const FIXTURES_DIR = path.join(fileURLToPath(import.meta.url), '..', 'fixtures');

async function readFixture(name: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(FIXTURES_DIR, name), 'utf-8');
  return JSON.parse(raw);
}

describe('WidgetTemplateSchema', () => {
  it('accepts the weather-card fixture, placeholders and all', async () => {
    const fixture = await readFixture('weather-card.widget.json');
    const result = WidgetTemplateSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('weather-card');
      // Placeholders survive validation untouched — the agent fills them later.
      expect(result.data.document.title).toBe('{{city}} weather');
    }
  });

  it('accepts a document with no placeholders at all', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'static-badge',
      description: 'A fixed badge with no fill-in slots.',
      document: {
        version: 1,
        root: { type: 'badge', text: 'Stable', tone: 'success' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a placeholder embedded inside a larger string field', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'greeting',
      description: 'A greeting heading.',
      document: {
        version: 1,
        root: { type: 'heading', text: 'Hello, {{name}}!' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a placeholder in the https-constrained image src field', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'avatar',
      description: 'An avatar image.',
      document: {
        version: 1,
        root: { type: 'image', src: '{{avatarUrl}}', alt: '{{name}}' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a placeholder in a number-only field (progress.value) with a targeted error', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'progress-card',
      description: 'A progress bar.',
      document: {
        version: 1,
        root: { type: 'progress', value: '{{percent}}' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toContain('Placeholder "{{percent}}" is not allowed in field "root.value"');
    }
  });

  it('rejects a placeholder in an enum field (badge.tone) with a targeted error', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'status-badge',
      description: 'A badge whose tone the author left as a placeholder.',
      document: {
        version: 1,
        root: { type: 'badge', text: 'Status', tone: '{{tone}}' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toContain('Placeholder "{{tone}}" is not allowed in field "root.tone"');
    }
  });

  it('keeps the raw schema error for non-placeholder failures', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'bad-progress',
      description: 'Progress value out of range.',
      document: {
        version: 1,
        root: { type: 'progress', value: 250 },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).not.toContain('Placeholder');
    }
  });

  it('accepts a fill-in numeric value routed through stat.value (string | number)', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'stat-card',
      description: 'A stat card whose value the agent fills in.',
      document: {
        version: 1,
        root: { type: 'stat', label: 'Count', value: '{{count}}' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a document missing the required root node', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'broken',
      description: 'Missing root.',
      document: { version: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown node type', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'broken',
      description: 'Bad node type.',
      document: { version: 1, root: { type: 'carousel' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing name', () => {
    const result = WidgetTemplateSchema.safeParse({
      description: 'No name.',
      document: { version: 1, root: { type: 'divider' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing description', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'no-description',
      document: { version: 1, root: { type: 'divider' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object document', () => {
    const result = WidgetTemplateSchema.safeParse({
      name: 'not-a-document',
      description: 'Document is a string, not an object.',
      document: 'not a widget document',
    });
    expect(result.success).toBe(false);
  });
});
