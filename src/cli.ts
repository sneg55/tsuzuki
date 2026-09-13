import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.js';
import { args, clients, saveJSON } from './runtime.js';
import { repoParts } from './config.js';
async function main() {
  const options = args(); const repo = String(options.repo ?? ''); repoParts(repo);
  const deps = clients(Boolean(options['dry-run']));
  const lock = join(tmpdir(), `tsuzuki-${createHash('sha256').update(deps.slack.bot).digest('hex').slice(0, 20)}.lock`);
  try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another local invocation holds ${lock}; remove only after verifying its process has stopped`); throw error; }
  try {
    const result = await run(repo, deps, { dryRun: Boolean(options['dry-run']) });
    const output = String(options.output ?? `artifacts/${result.id}`);
    await saveJSON(`${output}/run.json`, result);
    await saveJSON(`${output}/requests.json`, result.requests);
    console.log(result.digest || `Tsuzuki: ${result.status}`);
    for (const error of result.errors) console.error(error);
    if (result.status === 'error') process.exitCode = 1;
  } finally { await rm(lock, { recursive: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
