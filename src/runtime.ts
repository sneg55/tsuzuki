import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { GitHub } from './github.js';
import { Slack } from './slack.js';
import { Linear } from './linear.js';
import { anthropicModel } from './phrase.js';
import type { RequestEntry } from './types.js';
export function env(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
export function clients(dryRun = false) {
  const log: RequestEntry[] = [];
  return {
    log,
    github: new GitHub(env('GITHUB_TOKEN'), env('GITHUB_BOT_LOGIN'), log, dryRun),
    slack: new Slack(env('SLACK_BOT_TOKEN'), env('SLACK_BOT_USER_ID'), log, dryRun, process.env.SLACK_READ_TOKEN),
    linear: new Linear(env('LINEAR_API_KEY'), log, dryRun),
    ...(process.env.ANTHROPIC_API_KEY ? { createModel: (model: string) => anthropicModel(process.env.ANTHROPIC_API_KEY!, model, log) } : {}),
  };
}
export function args(extra: Record<string, { type: 'string' | 'boolean' }> = {}): Record<string, string | boolean | undefined> {
  return parseArgs({ options: { repo: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, output: { type: 'string' }, ...extra }, strict: true }).values;
}
export async function saveJSON(path: string, data: unknown): Promise<void> {
  const { dirname } = await import('node:path'); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
