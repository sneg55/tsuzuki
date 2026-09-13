import { parse } from 'yaml';
import { z } from 'zod';
const strings = z.array(z.string().min(1));
export const configSchema = z.object({
  nudge_after_days: z.number().nonnegative().default(7),
  min_gap_days: z.number().nonnegative().default(14),
  unsure_after_hours: z.number().nonnegative().default(24),
  never_close: z.literal(true).default(true),
  skip_authors: strings.default(['dependabot[bot]', 'renovate[bot]']),
  skip_labels: strings.default(['on-hold', 'wip']),
  optional_check_patterns: strings.default(['^\\[optional', 'codecov']).refine(xs => xs.every(x => { try { new RegExp(x); return true; } catch { return false; } }), 'Invalid check pattern'),
  cla_check_names: strings.default(['cla/signed', 'license/cla']),
  quiet_hours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).default({ start: 21, end: 8 }),
  labels: z.object({ contributor: z.literal('tsuzuki:contributor'), maintainer: z.literal('tsuzuki:maintainer') }).default({ contributor: 'tsuzuki:contributor', maintainer: 'tsuzuki:maintainer' }),
  phrase: z.object({ model: z.string().min(1) }).default({ model: 'claude-sonnet-5' }),
  slack: z.object({ channel: z.string().regex(/^[CG][A-Z0-9]+$/), history_depth: z.number().int().min(1).max(100).default(5), maintainers: strings.min(1) }),
  linear: z.object({ team_key: z.string().min(1) }),
}).strict();
export type Config = z.infer<typeof configSchema>;
export function parseConfig(input: string): Config { return configSchema.parse(parse(input)); }
export function repoParts(repo: string): { owner: string; repo: string } {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected --repo owner/repository');
  const [owner, name] = repo.split('/'); return { owner: owner!, repo: name! };
}
