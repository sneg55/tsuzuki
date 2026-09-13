import test from 'node:test';
import assert from 'node:assert/strict';
import { run, type Dependencies } from '../src/run.js';
import { emptyLedger } from '../src/ledger.js';
import { markerLine } from '../src/marker.js';
import { NOW, config, failed } from './helpers.js';
import type { Ledger, RequestEntry } from '../src/types.js';
function harness(options: { dryRun?: boolean; paused?: boolean; suppress?: number[]; failRead?: boolean; failComment?: number; failLinear?: boolean; failSlackRead?: boolean } = {}) {
  const log: RequestEntry[] = []; const writes: string[] = [];
  const emit = (app: RequestEntry['app'], path: string) => { if (options.dryRun) throw new Error('Unexpected dry-run write'); writes.push(`${app}:${path}`); log.push({ app, method: 'POST', path, at: NOW, write: true }); };
  const pulls = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, html_url: `https://github.com/o/r/pull/${i + 1}`, draft: false, labels: i === 5 ? [{ name: 'on-hold' }] : [] as { name: string }[], user: { login: i === 4 ? 'maintainer' : 'contributor', type: 'User' }, base: { ref: 'main' }, head: { sha: `sha${i + 1}` }, updated_at: '2026-08-01T12:00:00Z', mergeable: i !== 6 }));
  const comments = new Map<number, { id: number; user: { login: string }; body: string; created_at: string }[]>();
  comments.set(3, [{ id: 3, user: { login: 'BOT' }, body: `Prior nudge.\n${markerLine({ blocker: 'checks_failing', checks: [failed.name], also: [], head_sha: 'sha3' })}`, created_at: '2026-09-12T12:00:00Z' }]);
  const checks = (n: number) => n === 8 ? [{ ...failed, name: 'required', status: 'queued', conclusion: null }] : [3, 4, 5, 6].includes(n) ? [failed] : [];
  const c = { ...config, nudge_after_days: 0, unsure_after_hours: 0, skip_authors: ['maintainer'] };
  let ledger: Ledger = emptyLedger(NOW); ledger.repos['o/r'] = { prs: options.suppress ?? [], logins: [] };
  const github = {
    dryRun: !!options.dryRun, login: 'BOT', config: async () => c,
    list: async (route: string, p: any = {}) => {
      if (route.endsWith('/pulls')) return pulls;
      if (route.endsWith('/labels')) return [{ name: 'tsuzuki:contributor' }, { name: 'tsuzuki:maintainer' }];
      if (route.endsWith('/check-runs')) { if (options.failRead) throw new Error('GitHub read failed'); return checks(Number(p.ref.slice(3))); }
      if (route.endsWith('/statuses')) return [];
      if (route.endsWith('/reviews')) return [9, 10].includes(p.pull_number) ? [{ user: { login: 'reviewer', type: 'User' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T12:00:00Z', commit_id: p.pull_number === 9 ? 'sha9' : 'before-push' }] : [];
      if (route.endsWith('/timeline')) return [];
      if (route.endsWith('/comments')) return comments.get(p.issue_number) ?? [];
      throw new Error(`Unexpected read ${route}`);
    },
    call: async (route: string, p: any) => {
      if (route.endsWith('/pulls/{pull_number}')) return pulls.find(x => x.number === p.pull_number);
      if (route.endsWith('/protection')) return { required_status_checks: { contexts: ['required'] } };
      if (route.endsWith('/commits/{ref}')) return p.headers ? 'Date: Sun, 13 Sep 2026 16:00:00 +0000\n' : { commit: { committer: { date: NOW } } };
      throw new Error(`Unexpected call ${route}`);
    },
    ensureLabels: async () => {},
    comment: async (pr: any, body: string) => {
      emit('github', `/repos/o/r/issues/${pr.number}/comments`);
      if (pr.number === options.failComment) throw new Error('Comment rejected');
      comments.set(pr.number, [...(comments.get(pr.number) ?? []), { id: 100 + pr.number, user: { login: 'BOT' }, body, created_at: NOW }]);
      pulls.find(x => x.number === pr.number)!.updated_at = NOW;
    },
    labels: async (pr: any, add: string[], remove: string[]) => {
      if (add.length || remove.length) { emit('github', `/repos/o/r/issues/${pr.number}/labels`); const pull = pulls.find(x => x.number === pr.number)!; pull.labels = [...pull.labels.filter(x => !remove.includes(x.name)), ...add.map(name => ({ name }))]; }
    },
  };
  const slack = {
    dryRun: !!options.dryRun,
    inspect: async () => { if (options.failSlackRead) throw new Error('Cannot read pause'); return { ledger, ts: '1.0', paused: !!options.paused, busy: false, ignored: 0 }; },
    acquire: async (read: any, _config: unknown, holder: string) => { if (!options.dryRun) emit('slack', 'chat.update'); ledger = { ...ledger, lock: { holder, at: NOW } }; return { ...read, ledger }; },
    commands: async (read: any) => read,
    save: async () => emit('slack', 'chat.update'),
    release: async () => { emit('slack', 'chat.update'); ledger.lock = null; },
    post: async () => emit('slack', 'chat.postMessage'),
  };
  const linear = { dryRun: !!options.dryRun, team: async () => 'team', sync: async () => { if (!options.dryRun) emit('linear', 'issueUpdate'); if (options.failLinear) throw new Error('Linear unavailable'); return []; } };
  return { deps: { github, slack, linear, log } as unknown as Dependencies, writes, comments, pulls };
}
test('fixture-shaped run nudges exactly 4, 7, 9, skips six, and reports one unsure', async () => {
  const h = harness(); const result = await run('o/r', h.deps, { now: NOW });
  assert.equal(result.status, 'ok'); assert.deepEqual(result.rows.filter(x => x.nudged).map(x => x.number), [4, 7, 9]);
  assert.equal(result.rows.find(x => x.number === 8)?.decision.court, 'unsure'); assert.equal(result.rows.find(x => x.number === 3)?.outcome, 'stalled');
  assert.match(result.digest, /Nudged 3/); assert.match(result.digest, /Skipped 6/); assert.match(result.digest, /Unsure 1/);
  const comment = h.writes.indexOf('github:/repos/o/r/issues/4/comments'); const label = h.writes.indexOf('github:/repos/o/r/issues/4/labels'); assert.ok(comment < label);
});
test('rerun reads provider comments and produces no GitHub writes', async () => {
  const h = harness(); await run('o/r', h.deps, { now: NOW }); h.writes.length = 0; h.deps.log.length = 0;
  const second = await run('o/r', h.deps, { now: '2026-09-13T16:01:00Z' });
  assert.equal(second.status, 'ok'); assert.equal(h.writes.some(x => x.startsWith('github:')), false);
  assert.equal(second.rows.filter(x => x.nudged).length, 0);
});
test('suppression before first run silences only its target; paused run emits only the paused line', async () => {
  const h = harness({ suppress: [4] }); const first = await run('o/r', h.deps, { now: NOW });
  assert.deepEqual(first.rows.filter(x => x.nudged).map(x => x.number), [7, 9]); assert.equal(first.rows.find(x => x.number === 4)?.decision.reason, 'never_contact');
  const paused = harness({ paused: true }); const result = await run('o/r', paused.deps, { now: NOW }); assert.equal(result.status, 'paused'); assert.deepEqual(paused.writes, ['slack:chat.postMessage']);
});
test('GitHub and Slack read failures abort before all provider writes', async () => {
  for (const options of [{ failRead: true }, { failSlackRead: true }]) {
    const h = harness(options); const result = await run('o/r', h.deps, { now: NOW }); assert.equal(result.status, 'error'); assert.deepEqual(h.writes, []);
  }
});
test('partial comment failure continues other PRs; Linear failure preserves nudge markers', async () => {
  const h = harness({ failComment: 4 }); const result = await run('o/r', h.deps, { now: NOW });
  assert.equal(result.status, 'error'); assert.deepEqual(result.rows.filter(x => x.nudged).map(x => x.number), [7, 9]); assert.equal(result.rows.find(x => x.number === 4)?.errors.length, 1);
  const linear = harness({ failLinear: true }); const partial = await run('o/r', linear.deps, { now: NOW }); assert.equal(partial.status, 'error'); assert.equal(linear.comments.get(4)?.length, 1);
  linear.writes.length = 0; await run('o/r', linear.deps, { now: '2026-09-13T16:01:00Z' }); assert.equal(linear.writes.some(x => x.endsWith('/comments')), false); assert.ok(linear.writes.some(x => x.startsWith('linear:')));
});
test('dry run executes decisions and mirror reads without any provider mutation', async () => {
  const h = harness({ dryRun: true }); const result = await run('o/r', h.deps, { now: NOW, dryRun: true });
  assert.equal(result.status, 'ok'); assert.deepEqual(h.writes, []); assert.deepEqual(result.rows.filter(x => x.nudged).map(x => x.number), [4, 7, 9]);
});
