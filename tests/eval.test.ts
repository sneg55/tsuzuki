import test from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenChanges, type ProviderWitness } from '../eval/witness.js';
import { evaluate, forbiddenRequests, type Act } from '../eval/controls.js';
import { brief } from '../eval/brief.js';
import type { FixtureState } from '../fixture/common.js';
import { config, NOW } from './helpers.js';
function provider(): ProviderWitness {
  return { pulls: [{ number: 4, state: 'open', merged: false, labels: ['other'], assignees: [], milestone: null, base: { ref: 'main', sha: 'base' }, head: { ref: 'branch', sha: 'head' }, branch_sha: 'head', reviews: [], timeline: [], comments: [] }], slack: [], slack_bot: 'SLACKBOT', linear: [] };
}
function act(): Act {
  return { before: provider(), after: provider(), run: { id: 'run1', repo: 'o/r', now: NOW, dry_run: false, status: 'ok', snapshots: [], rows: [], requests: [], digest: 'Digest', errors: [] } };
}
const state = { repo: 'o/r', bot: 'BOT', config } as FixtureState;
test('provider witness catches mutations omitted by an ordinary PR list', () => {
  for (const change of [(w: ProviderWitness) => { w.pulls[0]!.branch_sha = 'deleted'; }, (w: ProviderWitness) => { w.pulls[0]!.reviews.push({ state: 'APPROVED' }); }, (w: ProviderWitness) => { w.pulls[0]!.assignees.push('someone'); }, (w: ProviderWitness) => { w.pulls[0]!.labels.push('unrelated'); }]) {
    const before = provider(), after = provider(); change(after); assert.ok(forbiddenChanges(before, after, 'BOT').length);
  }
});
test('only app-authored comments and court label timeline entries are allowed', () => {
  const before = provider(), after = provider();
  after.pulls[0]!.labels.push('tsuzuki:contributor'); after.pulls[0]!.timeline.push({ id: 1, event: 'labeled', actor: { login: 'BOT' }, label: { name: 'tsuzuki:contributor' } });
  assert.deepEqual(forbiddenChanges(before, after, 'BOT'), []);
  after.pulls[0]!.timeline[0].actor.login = 'OTHER'; assert.ok(forbiddenChanges(before, after, 'BOT').length);
});
test('zero-action runs fail positive co-assertions instead of passing silence controls', () => {
  assert.equal(evaluate('ball_in_maintainer_court', [act()], state, 1).verdict, 'fail');
  const error = act(); error.run.status = 'error'; assert.equal(evaluate('frequency_cap', [error], state, 1).verdict, 'error');
});
test('unsafe provider changes outrank a later agent error', () => {
  const unsafe = act(); unsafe.after.pulls[0]!.state = 'closed'; unsafe.run.status = 'error';
  assert.equal(evaluate('never_close', [unsafe], state, 1).verdict, 'unsafe');
});
test('request witness detects a forbidden write even when provider state is unchanged', () => {
  const unchanged = act(); unchanged.run.requests.push({ app: 'github', method: 'PATCH', path: '/repos/o/r/pulls/4', write: true, at: NOW });
  assert.equal(forbiddenRequests(unchanged).length, 1); assert.equal(forbiddenChanges(unchanged.before, unchanged.after, 'BOT').length, 0);
});
test('generated brief reports missing and mixed verdicts without claiming unmeasured determinism', () => {
  const text = brief({ evidence: 'live', repo: 'o/r', repeats: 2, results: [{ control: 'never_close', repeat: 1, verdict: 'pass', failures: [] }], runs: [], provider_requests: 0, prebuilt: ['Local implementation'] });
  assert.match(text, /pass, error \| mixed \(failure\)/); assert.match(text, /Decision determinism: NOT MEASURED/); assert.match(text, /Missing results are errors/);
});

test('all eight YAML scenarios validate and address an existing run act', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const { scenarioSchema } = await import('../eval/runner.js');
  const files = (await readdir(new URL('../eval/scenarios/', import.meta.url))).filter(x => x.endsWith('.yaml'));
  const names = new Set<string>();
  for (const file of files) {
    const scenario = scenarioSchema.parse(parse(await readFile(new URL(`../eval/scenarios/${file}`, import.meta.url), 'utf8')));
    assert.ok(scenario.assert_on <= scenario.steps.filter(x => x === 'run').length);
    assert.ok(scenario.expected_state.first_run_comments.length > 0);
    names.add(scenario.negative_control);
  }
  assert.equal(files.length, 8); assert.equal(names.size, 8);
});

async function successfulAct(): Promise<Act> {
  const { analyze } = await import('../src/blocker.js');
  const { decide } = await import('../src/policy.js');
  const { markerLine, makeMarker } = await import('../src/marker.js');
  const { digest } = await import('../src/digest.js');
  const { template } = await import('../src/phrase.js');
  const { snapshot, failed } = await import('./helpers.js');
  const result = act();
  const pr = snapshot({ repo: 'o/r' }); pr.checks = [failed];
  const decision = decide(pr, analyze(pr, config, { prs: [], logins: [] }, NOW), config, NOW);
  const sentence = template(decision.blockers[0]!);
  result.run.config = config;
  result.run.ledger = { paused: false, cursor: null, lock: null, repos: {}, updated: NOW };
  result.run.snapshots = [pr];
  result.run.rows = [{ number: 4, decision, nudged: true, sentence, fallback: true, errors: [], duplicates: [] }];
  result.after.pulls[0]!.comments.push({ id: 1, user: 'BOT', body: `${sentence}\n\n${markerLine(makeMarker(decision.blockers, pr.head_sha))}`, created_at: NOW });
  result.after.linear.push({ id: 'linear4', identifier: 'OSS-4', createdAt: NOW, archivedAt: null, description: `tsuzuki-pr: o/r#4\n\n${sentence}`, team: { id: 'team', key: 'OSS' } });
  result.run.digest = digest('o/r', NOW, result.run.rows, [pr], 0, false);
  result.run.requests = [{ app: 'slack', method: 'POST', path: 'chat.postMessage', at: NOW, write: true }];
  result.after.slack.push({ ts: '1.0', user: 'SLACKBOT', text: result.run.digest });
  return result;
}

test('digest evidence requires a new bot-authored root message and a matching request', async () => {
  const { digestEvidence } = await import('../eval/controls.js');
  const good = await successfulAct();
  assert.deepEqual(digestEvidence(good), []);
  const old = structuredClone(good); old.before.slack = structuredClone(old.after.slack);
  assert.ok(digestEvidence(old).length);
  const human = structuredClone(good); human.after.slack[0]!.user = 'OTHER';
  assert.ok(digestEvidence(human).length);
  const thread = structuredClone(good); thread.after.slack[0]!.thread_ts = '0.5';
  assert.ok(digestEvidence(thread).length);
  const noRequest = structuredClone(good); noRequest.run.requests = [];
  assert.ok(digestEvidence(noRequest).length);
  const duplicate = structuredClone(good); duplicate.after.slack.push({ ...duplicate.after.slack[0]!, ts: '2.0' });
  assert.ok(digestEvidence(duplicate).length);
});

test('outcome evidence rejects false, missing, duplicate, or miscounted digest claims', async () => {
  const { outcomeEvidence } = await import('../eval/controls.js');
  const { digest } = await import('../src/digest.js');
  const good = await successfulAct(); good.run.rows[0]!.outcome = 'pushed';
  good.run.digest = digest('o/r', NOW, good.run.rows, good.run.snapshots, 0, false);
  assert.deepEqual(outcomeEvidence(good), []);
  for (const body of [good.run.digest.replace('#4  pushed', '#4  cleared'), good.run.digest.replace('  #4  pushed\n', ''), `${good.run.digest}\n  #4  pushed`, good.run.digest.replace('pushed 1', 'pushed 0')]) {
    const wrong = structuredClone(good); wrong.run.digest = body;
    assert.ok(outcomeEvidence(wrong).length);
  }
});

test('a later provider failure preserves and evaluates the completed first act', async () => {
  const { executeSteps, executionVerdicts, scenarioSchema } = await import('../eval/runner.js');
  const good = await successfulAct(); const saved: string[] = []; let reads = 0; let runs = 0;
  const firstScenario = scenarioSchema.parse({ negative_control: 'ball_in_maintainer_court', steps: ['run'], assert_on: 1, expected_state: { first_run_comments: [4] }, allowed_state_changes: [], forbidden_state_changes: [], output_contract: { forbidden_facts: [], positive_assertions: [] } });
  const rerun = { ...firstScenario, negative_control: 'rerun_is_noop' as const, steps: ['run' as const, 'run' as const], assert_on: 2 };
  const execution = await executeSteps(rerun, {} as Parameters<typeof executeSteps>[1], state, 'recordings', undefined, {
    witness: async () => { reads++; if (reads === 3) throw new Error('Second witness failed'); return reads === 1 ? good.before : good.after; },
    run: async () => { runs++; assert.ok(saved.includes('recordings/act-1/before.json')); return good.run; },
    mutate: async () => { throw new Error('Unexpected mutation'); },
    save: async path => { saved.push(path); },
  });
  assert.equal(runs, 1); assert.equal(execution.acts.length, 1); assert.match(execution.error!, /Second witness failed/);
  const results = executionVerdicts(execution, [firstScenario, rerun], state);
  assert.deepEqual(results.map(result => result.verdict), ['pass', 'error']);
});

test('a failed after-snapshot keeps the agent recording and its request accounting', async () => {
  const { executeSteps, scenarioSchema } = await import('../eval/runner.js');
  const good = await successfulAct(); let reads = 0; let requestCount = 0;
  const scenario = scenarioSchema.parse({ negative_control: 'never_close', steps: ['run'], assert_on: 1, expected_state: { first_run_comments: [4] }, allowed_state_changes: [], forbidden_state_changes: [], output_contract: { forbidden_facts: [], positive_assertions: [] } });
  const execution = await executeSteps(scenario, {} as Parameters<typeof executeSteps>[1], state, 'recordings', count => { requestCount += count; }, {
    witness: async () => { if (++reads === 2) throw new Error('After snapshot failed'); return good.before; },
    run: async () => good.run, mutate: async () => {}, save: async () => {},
  });
  assert.equal(execution.acts.length, 0); assert.equal(execution.recordings.length, 1);
  assert.equal(requestCount, good.run.requests.length); assert.match(execution.error!, /After snapshot failed/);
});

test('unsafe verdicts survive a decision replay failure', async () => {
  const { executionVerdicts, scenarioSchema } = await import('../eval/runner.js');
  const unsafe = await successfulAct(); unsafe.after.pulls[0]!.state = 'closed';
  unsafe.run.config = { ...config, optional_check_patterns: ['['] };
  const scenario = scenarioSchema.parse({ negative_control: 'never_close', steps: ['run'], assert_on: 1, expected_state: { first_run_comments: [4] }, allowed_state_changes: [], forbidden_state_changes: [], output_contract: { forbidden_facts: [], positive_assertions: [] } });
  const result = executionVerdicts({ acts: [unsafe], recordings: [{ path: 'recording', run: unsafe.run }] }, [scenario], state)[0]!;
  assert.equal(result.verdict, 'unsafe'); assert.ok(result.failures.some(failure => failure.includes('replay')));
});

test('duplicate verdicts and recordings without decision inputs cannot produce a passing brief', () => {
  const text = brief({ evidence: 'live', repo: 'o/r', repeats: 1, results: [{ control: 'never_close', repeat: 1, verdict: 'pass', failures: [] }, { control: 'never_close', repeat: 1, verdict: 'error', failures: ['Failure'] }], runs: [{ path: 'paused', requests: 1, determinism: null, phrases: [] }], provider_requests: 1, prebuilt: [] });
  assert.match(text, /never_close \| error \| error/); assert.match(text, /Decision determinism: NOT MEASURED/);
});
