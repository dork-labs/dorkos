import { describe, it, expect } from 'vitest';
import {
  TemplateCategorySchema,
  TemplateEntrySchema,
  TemplateCatalogSchema,
  DEFAULT_TEMPLATES,
} from '../template-catalog.js';
import type { TemplateCatalog } from '../template-catalog.js';

describe('TemplateCategorySchema', () => {
  it('accepts valid categories', () => {
    const valid = ['general', 'frontend', 'backend', 'library', 'tooling', 'custom'] as const;
    for (const category of valid) {
      expect(TemplateCategorySchema.parse(category)).toBe(category);
    }
  });

  it('rejects invalid category', () => {
    expect(() => TemplateCategorySchema.parse('devops')).toThrow();
  });
});

describe('TemplateEntrySchema', () => {
  const validEntry = {
    id: 'test',
    name: 'Test Template',
    description: 'A test template',
    source: 'github:test/repo',
    category: 'general' as const,
  };

  it('parses a valid entry with defaults', () => {
    const result = TemplateEntrySchema.parse(validEntry);
    expect(result.builtin).toBe(false);
    expect(result.tags).toEqual([]);
  });

  it('accepts explicit builtin and tags', () => {
    const result = TemplateEntrySchema.parse({
      ...validEntry,
      builtin: true,
      tags: ['react', 'spa'],
    });
    expect(result.builtin).toBe(true);
    expect(result.tags).toEqual(['react', 'spa']);
  });

  it('rejects empty id', () => {
    expect(() => TemplateEntrySchema.parse({ ...validEntry, id: '' })).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => TemplateEntrySchema.parse({ ...validEntry, name: '' })).toThrow();
  });

  it('allows empty source for blank templates', () => {
    const result = TemplateEntrySchema.parse({ ...validEntry, source: '' });
    expect(result.source).toBe('');
  });

  it('rejects invalid category', () => {
    expect(() => TemplateEntrySchema.parse({ ...validEntry, category: 'unknown' })).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => TemplateEntrySchema.parse({})).toThrow();
    expect(() => TemplateEntrySchema.parse({ id: 'x' })).toThrow();
  });
});

describe('TemplateCatalogSchema', () => {
  it('parses a valid catalog', () => {
    const catalog = {
      version: 1,
      templates: [
        {
          id: 'test',
          name: 'Test',
          description: 'desc',
          source: 'github:test/repo',
          category: 'general',
        },
      ],
    };
    const result = TemplateCatalogSchema.parse(catalog);
    expect(result.version).toBe(1);
    expect(result.templates).toHaveLength(1);
  });

  it('rejects missing version', () => {
    expect(() => TemplateCatalogSchema.parse({ templates: [] })).toThrow();
  });

  it('rejects invalid version', () => {
    expect(() => TemplateCatalogSchema.parse({ version: 2, templates: [] })).toThrow();
  });

  it('accepts empty templates array', () => {
    const result = TemplateCatalogSchema.parse({ version: 1, templates: [] });
    expect(result.templates).toEqual([]);
  });

  it('rejects invalid template entries', () => {
    expect(() =>
      TemplateCatalogSchema.parse({
        version: 1,
        templates: [{ id: '' }],
      })
    ).toThrow();
  });

  it('satisfies TemplateCatalog type', () => {
    const catalog: TemplateCatalog = TemplateCatalogSchema.parse({
      version: 1,
      templates: DEFAULT_TEMPLATES,
    });
    expect(catalog.version).toBe(1);
  });
});

describe('DEFAULT_TEMPLATES', () => {
  it('all entries have builtin: true', () => {
    for (const template of DEFAULT_TEMPLATES) {
      expect(template.builtin).toBe(true);
    }
  });

  it('all entries have unique ids', () => {
    const ids = DEFAULT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all entries pass schema validation', () => {
    for (const template of DEFAULT_TEMPLATES) {
      expect(() => TemplateEntrySchema.parse(template)).not.toThrow();
    }
  });

  it('wraps into a valid catalog', () => {
    expect(() =>
      TemplateCatalogSchema.parse({ version: 1, templates: DEFAULT_TEMPLATES })
    ).not.toThrow();
  });

  it('all entries have non-empty tags', () => {
    for (const template of DEFAULT_TEMPLATES) {
      expect(template.tags.length).toBeGreaterThan(0);
    }
  });

  it('blank template has empty source', () => {
    const blank = DEFAULT_TEMPLATES.find((t) => t.id === 'blank');
    expect(blank).toBeDefined();
    expect(blank!.source).toBe('');
  });

  it('non-blank templates have github source prefix', () => {
    const nonBlank = DEFAULT_TEMPLATES.filter((t) => t.id !== 'blank');
    for (const template of nonBlank) {
      expect(template.source).toMatch(/^github:dorkos-templates\//);
    }
  });
});
