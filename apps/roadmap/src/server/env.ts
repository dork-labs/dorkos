import { z } from 'zod';

const roadmapEnvSchema = z.object({
  ROADMAP_PORT: z.coerce.number().int().min(1).max(65535).default(4243),
  ROADMAP_PROJECT_ROOT: z.string().default(process.cwd()),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const result = roadmapEnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('\n  Roadmap: invalid environment variables:\n');
  result.error.issues.forEach(i => console.error(`  - ${i.path.join('.')}: ${i.message}`));
  process.exit(1);
}

export const env = result.data;
export type RoadmapEnv = typeof env;
