import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { fixtureClients, readState, pushTo, type FixtureClients, type FixtureState } from '../fixture/common.js';
import { reset } from '../fixture/reset.js';
import { args, clients, env, saveJSON } from '../src/runtime.js';
import { run, type RunResult } from '../src/run.js';
import { analyze } from '../src/blocker.js';
import { decide } from '../src/policy.js';
import { witness, type ProviderWitness } from './witness.js';
import { controls, evaluate, type Act, type Verdict } from './controls.js';
export const scenarioSchema = z.object({
  negative_control: z.enum(controls),
  steps: z.array(z.union([z.literal('run'), z.object({ mutate: z.union([z.object({ push_to: z.array(z.number().int()) }).strict(), z.object({ reply: z.string() }).strict(), z.object({ pause: z.literal(true) }).strict()]) }).strict()])),
  assert_on: z.number().int().positive(), expected_state: z.object({ first_run_comments: z.array(z.number().int().positive()), silent_prs: z.array(z.number().int().positive()).optional(), no_github_writes: z.boolean().optional(), outcomes: z.record(z.string(), z.string()).optional(), run_status: z.string().optional() }).strict(),
  allowed_state_changes: z.array(z.string()), forbidden_state_changes: z.array(z.string()),
  output_contract: z.object({ forbidden_facts: z.array(z.string()), positive_assertions: z.array(z.string()) }),
}).strict();
export type Scenario = z.infer<typeof scenarioSchema>;
export type EvalReport = { evidence: 'live'; repo: string; repeats: number; results: (Verdict & { repeat: number })[]; runs: { path: string; requests: number; determinism: boolean | null; phrases: { key: string; sentence: string; fallback: boolean }[] }[]; provider_requests: number; prebuilt: string[] };
export function replay(act: Pick<Act, 'run'>): boolean | null {
  const { config, ledger, now, snapshots } = act.run;
  if (!config || !ledger || !snapshots.length) return null;
  try {
    const evaluate = () => JSON.stringify(snapshots.map(pr => decide(pr, analyze(pr, config, ledger.repos[pr.repo] ?? { prs: [], logins: [] }, now), config, now)));
    const expected = evaluate();
    for (let i = 0; i < 100; i++) if (evaluate() !== expected) return false;
    return true;
  } catch { return false; }
}
export type StepMutation = Exclude<Scenario['steps'][number], 'run'>['mutate'];
export type StepRuntime = {
  witness: () => Promise<ProviderWitness>;
  run: () => Promise<RunResult>;
  mutate: (mutation: StepMutation) => Promise<void>;
  save: (path: string, data: unknown) => Promise<void>;
};
export type Execution = { acts: Act[]; recordings: { path: string; run: RunResult }[]; error?: string };
export async function executeSteps(scenario: Scenario, ctx: FixtureClients, state: FixtureState, output: string, onRun?: (requests: number) => void, runtime?: StepRuntime): Promise<Execution> {
  const io: StepRuntime = runtime ?? {
    witness: () => witness(ctx, state),
    run: () => run(state.repo, clients()),
    mutate: async mutation => {
      if ('push_to' in mutation) await pushTo(ctx, state, mutation.push_to);
      else if ('reply' in mutation) await ctx.app.slack.call('chat.postMessage', { channel: state.config.slack.channel, thread_ts: state.ledger_ts, text: mutation.reply.replaceAll('{repo}', state.repo) }, env('FIXTURE_SLACK_USER_TOKEN'));
      else await ctx.app.slack.call('reactions.add', { channel: state.config.slack.channel, timestamp: state.ledger_ts, name: 'no_entry_sign' }, env('FIXTURE_SLACK_USER_TOKEN'));
    },
    save: saveJSON,
  };
  const execution: Execution = { acts: [], recordings: [] };
  try {
    for (const step of scenario.steps) {
      if (step !== 'run') { await io.mutate(step.mutate); continue; }
      const path = `${output}/act-${execution.acts.length + 1}`;
      const before = await io.witness();
      await io.save(`${path}/before.json`, before);
      const result = await io.run();
      execution.recordings.push({ path, run: result });
      onRun?.(result.requests.length);
      await io.save(`${path}/run.json`, result);
      await io.save(`${path}/requests.json`, result.requests);
      const after = await io.witness();
      await io.save(`${path}/after.json`, after);
      execution.acts.push({ before, after, run: result });
      if (!['ok', 'paused'].includes(result.status)) throw new Error(`Agent act ended with status ${result.status}`);
    }
  } catch (error) {
    execution.error = error instanceof Error ? error.message : 'Provider or readiness failure';
    // Complete acts remain independently assertable; an incomplete act cannot pass.
  }
  return execution;
}
export function executionVerdicts(execution: Execution, selected: Scenario[], state: FixtureState): Verdict[] {
  return selected.map(item => {
    const verdict = evaluate(item.negative_control, execution.acts, state, item.assert_on, item.expected_state, item.output_contract.forbidden_facts);
    if (execution.error && verdict.verdict === 'error') verdict.failures.push(execution.error);
    const relevant = execution.recordings.filter((_, index) => index === 0 || index === item.assert_on - 1);
    if (relevant.some(recording => replay(recording) === false)) {
      if (verdict.verdict === 'pass') verdict.verdict = 'fail';
      verdict.failures.push('Recorded decision replay changed or failed');
    }
    return verdict;
  });
}
export async function evaluateLive(state: FixtureState, output: string, repeats = 5, prebuilt: string[] = []): Promise<EvalReport> {
  const filenames = (await readdir(new URL('./scenarios/', import.meta.url))).filter(x => x.endsWith('.yaml')).sort();
  const scenarios = await Promise.all(filenames.map(async name => scenarioSchema.parse(parse(await readFile(new URL(`./scenarios/${name}`, import.meta.url), 'utf8')))));
  if (scenarios.length !== controls.length || new Set(scenarios.map(x => x.negative_control)).size !== controls.length) throw new Error('Expected one scenario for each of eight controls');
  const report: EvalReport = { evidence: 'live', repo: state.repo, repeats, results: [], runs: [], provider_requests: 0, prebuilt };
  const ctx = fixtureClients(); let agentRequests = 0;
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const group of ['rerun_is_noop', 'moved_is_measured', 'suppression_honored'] as const) {
      const scenario = scenarios.find(x => x.negative_control === group)!;
      const selected = group === 'rerun_is_noop' ? scenarios.filter(x => !['moved_is_measured', 'suppression_honored'].includes(x.negative_control)) : [scenario];
      const dir = `${output}/repeat-${repeat}/${group}`;
      console.log(`Evaluating repeat ${repeat}/${repeats}: ${group}`);
      try {
        await reset(state, ctx);
        const execution = await executeSteps(scenario, ctx, state, dir, count => { agentRequests += count; });
        const verdicts = executionVerdicts(execution, selected, state);
        const recordings = execution.recordings.map(recording => ({
          path: recording.path, requests: recording.run.requests.length, determinism: replay(recording),
          phrases: recording.run.rows.filter(row => row.nudged && row.sentence).map(row => ({ key: JSON.stringify(row.decision.blockers), sentence: row.sentence!, fallback: row.fallback ?? false })),
        }));
        if (execution.error) await saveJSON(`${dir}/error.json`, { error: execution.error });
        report.runs.push(...recordings);
        report.results.push(...verdicts.map(verdict => ({ ...verdict, repeat })));
      } catch (error) {
        for (const item of selected) report.results.push({ control: item.negative_control, repeat, verdict: 'error', failures: [error instanceof Error ? error.message : 'Provider or readiness failure'] });
      }
      report.provider_requests = ctx.log.length + ctx.app.log.length + agentRequests;
      await saveJSON(`${output}/eval.json`, report);
      await saveJSON(`${output}/fixture-requests.json`, [...ctx.log, ...ctx.app.log]);
    }
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = args({ state: { type: 'string' }, repeats: { type: 'string' }, prebuilt: { type: 'string' } });
  const repeats = Number(options.repeats ?? 5);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be an integer from 1 to 20');
  if (options['dry-run']) throw new Error('Evaluation requires live fixture writes; unit tests are available through npm test');
  const prebuilt = options.prebuilt ? JSON.parse(await readFile(String(options.prebuilt), 'utf8')) as string[] : ['Prebuilt inventory not supplied; disclosure incomplete.'];
  readState(String(options.state ?? 'fixture/state.json'), options.repo as string | undefined)
    .then(state => evaluateLive(state, String(options.output ?? 'artifacts/eval'), repeats, prebuilt))
    .then(report => { if (report.results.some(x => x.verdict !== 'pass')) process.exitCode = 1; console.log(`Evaluation recorded ${report.results.length} control verdicts.`); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
