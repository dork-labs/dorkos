/**
 * The agent template catalog: the built-in templates plus the ones a person
 * added, kept in `{dorkHome}/agent-templates.json`.
 *
 * Reading it is the capability `templates.list` (ADR 261123-170830), served by
 * the capability mount at `GET /api/templates` from the same data directory the
 * routes write (`templateDeps`). Adding and removing a template
 * are still hand routes (`routes/templates.ts`), which share the file helpers
 * here.
 *
 * @module services/core/agent-templates/template-catalog
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_TEMPLATES,
  TemplateCatalogSchema,
  type TemplateCatalog,
  type TemplateEntry,
} from '@dorkos/shared/template-catalog';

import { logger } from '../../../lib/logger.js';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../capabilities/index.js';

declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present where the template routes are mounted; gates the `templates` domain. */
    templateDeps?: {
      /** The data directory the user templates live in, the one the template routes write. */
      dorkHome: string;
    };
  }
}

/**
 * The data directory the template routes write to.
 *
 * @param deps - The capability bag.
 */
function templateHomeOf(deps: CapabilityDeps): string {
  if (!deps.templateDeps) {
    throw new Error('templates.list invoked without templateDeps in the registry bag.');
  }
  return deps.templateDeps.dorkHome;
}

/** Filename for user-defined templates within the dorkHome directory. */
const USER_CATALOG_FILENAME = 'agent-templates.json';

/**
 * Where the user templates live.
 *
 * @param dorkHome - The DorkOS data directory.
 */
export function userTemplateCatalogPath(dorkHome: string): string {
  return path.join(dorkHome, USER_CATALOG_FILENAME);
}

/**
 * Read user templates from disk. A missing or malformed file reads as no
 * templates, so the built-in ones are always offered.
 *
 * @param catalogPath - The user catalog's path ({@link userTemplateCatalogPath}).
 */
export async function readUserTemplates(catalogPath: string): Promise<TemplateEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(catalogPath, 'utf-8');
  } catch {
    // File doesn't exist yet — not an error
    return [];
  }

  try {
    const result = TemplateCatalogSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      logger.warn('[templates] Malformed catalog file, treating as empty', {
        path: catalogPath,
        errors: z.flattenError(result.error),
      });
      return [];
    }
    return result.data.templates;
  } catch {
    logger.warn('[templates] Failed to parse catalog JSON, treating as empty', {
      path: catalogPath,
    });
    return [];
  }
}

/**
 * Serialize user templates through the enclosing lock's writer.
 *
 * The write must be atomic as well as serialised (DOR-697): a plain
 * `fs.writeFile` truncates in place, so a reader catching the mid-truncation
 * state parse-fails to `[]`, and because {@link readUserTemplates} treats
 * every read failure as an empty catalog, the next write would then erase
 * every user template.
 *
 * @param write - The atomic writer supplied by the enclosing `withFileLock`.
 * @param templates - The user templates to persist.
 */
export async function writeUserTemplates(
  write: (data: string) => Promise<void>,
  templates: TemplateEntry[]
): Promise<void> {
  const catalog: TemplateCatalog = { version: 1, templates };
  await write(JSON.stringify(catalog, null, 2));
}

/** `templates.list`: the built-in templates, then the ones a person added. */
export const templatesListCapability = defineCapability({
  id: 'templates.list',
  title: 'List agent templates',
  description:
    'The templates a new agent can start from: the built-in ones, then the ones a person ' +
    'added. Each has an id, a name, a description, a source to copy from and a category.',
  tier: 'observe',
  area: null,
  areaNote: 'reading the template catalog',
  input: z.object({}),
  // Documented as unknown until the list pages by cursor (the API lint's list rule).
  output: z.unknown(),
  surfaces: { http: { method: 'get', path: '/api/templates' } },
  invoke: async (deps): Promise<TemplateCatalog> => {
    const userTemplates = await readUserTemplates(userTemplateCatalogPath(templateHomeOf(deps)));
    return { version: 1, templates: [...DEFAULT_TEMPLATES, ...userTemplates] };
  },
});

/** The template catalog's reads; where the template routes are mounted. */
export const templatesDomain: CapabilityDomain = {
  name: 'templates',
  assertDeps: templateHomeOf,
  capabilities: [templatesListCapability],
};
