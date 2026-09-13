import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, allowedGitHubWrite } from '../src/github.js';
import { Slack } from '../src/slack.js';
import { Linear } from '../src/linear.js';
import { anthropicModel, validateSentence } from '../src/phrase.js';
import { emptyLedger, encodeLedger } from '../src/ledger.js';
import { NOW, config, snapshot } from './helpers.js';
import type { RequestEntry } from '../src/types.js';
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
test('GitHub mutation allowlist rejects close, merge, refs, reviews and foreign labels', () => {
  for (const [method, path, body] of [
    ['PATCH', '/repos/o/r/pulls/1', { state: 'closed' }], ['PUT', '/repos/o/r/pulls/1/merge', {}], ['DELETE', '/repos/o/r/git/refs/heads/main', {}], ['POST', '/repos/o/r/pulls/1/reviews', {}], ['POST', '/repos/o/r/issues/1/labels', { labels: ['approved'] }], ['DELETE', '/repos/o/r/issues/1/labels/on-hold', {}],
  ] as const) assert.equal(allowedGitHubWrite(method, path, body), false);
  assert.equal(allowedGitHubWrite('POST', '/repos/o/r/issues/1/comments', { body: 'Nudge.' }), true);
  assert.equal(allowedGitHubWrite('DELETE', '/repos/o/r/issues/1/labels/tsuzuki%3Amaintainer', {}), true);
});
test('dry-run wrappers reject provider mutations before any request reaches the network', async () => {
  const log: RequestEntry[] = [];
  const gh = new GitHub('token', 'bot', log, true);
  const slack = new Slack('token', 'BOT', log, true);
  const linear = new Linear('token', log, true);
  await assert.rejects(gh.call('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: 'o', repo: 'r', issue_number: 1, body: 'Nudge.' }), /Dry run/);
  await assert.rejects(slack.post('C123', 'Message'), /Dry run/);
  await assert.rejects(linear.query('issueCreate', 'mutation { issueCreate { success } }'), /Dry run/);
  assert.deepEqual(log, []);
});
test('GitHub logs each paginated HTTP read and keeps secrets out of the log', async () => {
  const log: RequestEntry[] = []; const gh = new GitHub('private-token', 'bot', log);
  let calls = 0;
  gh.octokit.hook.wrap('request', async (request, options) => {
    options.request = { ...options.request, fetch: async () => {
      calls++; return new Response(JSON.stringify([{ id: calls }]), { status: 200, headers: { 'content-type': 'application/json', ...(calls === 1 ? { link: '<https://api.github.com/repos/o/r/issues/1/comments?page=2>; rel="next"' } : {}) } });
    } };
    return request(options);
  });
  assert.equal((await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: 'o', repo: 'r', issue_number: 1 })).length, 2);
  assert.equal(log.length, 2); assert.equal(JSON.stringify(log).includes('private-token'), false);
});
test('Slack pause read occurs before lock writes and failing reads propagate', async t => {
  const log: RequestEntry[] = []; const slack = new Slack('token', 'BOT', log);
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname.split('/').at(-1)!; paths.push(path);
    if (path === 'pins.list') return json({ ok: true, items: [{ message: { ts: '1.0', user: 'BOT', text: encodeLedger(emptyLedger(NOW)) } }] });
    if (path === 'reactions.get') return json({ ok: true, message: { reactions: [{ name: 'no_entry_sign', count: 1 }] } });
    throw new Error('Unexpected request');
  });
  assert.equal((await slack.inspect(config, NOW)).paused, true); assert.deepEqual(paths, ['pins.list', 'reactions.get']); assert.equal(log.some(x => x.write), false);
});
test('a phrased sentence carrying an at-mention is rejected', () => {
  const blocker = { kind: 'changes_requested', artifacts: ['sneg55'], dates: ['2026-09-13T00:00:00Z'] } as never;
  assert.equal(validateSentence('sneg55 requested changes; no push has landed.', blocker), true);
  assert.equal(validateSentence('@sneg55 requested changes; no push has landed.', blocker), false);
});

test('an absent read credential leaves thread reads on the bot token', async t => {
  const log: RequestEntry[] = []; const slack = new Slack('bot-token', 'BOT', log, false, undefined);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer bot-token');
    return json({ ok: true, messages: [] });
  });
  await slack.messages('conversations.replies', { channel: 'C', ts: '1.0' });
});

test('Slack commands paginate replies and use a separate read credential only for thread reads', async t => {
  const log: RequestEntry[] = []; const slack = new Slack('bot-token', 'BOT', log, false, 'read-token'); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer read-token'); calls++;
    return json({ ok: true, messages: [{ ts: `${calls}.0` }], response_metadata: { next_cursor: calls === 1 ? 'next' : '' } });
  });
  assert.equal((await slack.messages('conversations.replies', { channel: 'C123', ts: '0.0' })).length, 2); assert.equal(log.length, 2);
});
test('Linear description fallback repairs orphan attachment without creating a duplicate issue', async t => {
  const log: RequestEntry[] = []; const linear = new Linear('token', log); const operations: string[] = [];
  const issue = { id: 'issue1', identifier: 'OSS-1', createdAt: NOW, archivedAt: null, description: 'tsuzuki-pr: owner/repo#4', team: { id: 'team1', key: 'OSS' } };
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes('attachmentsForURL')) return json({ data: { attachmentsForURL: { nodes: [], pageInfo: { hasNextPage: false } } } });
    if (query.includes('query Issues')) return json({ data: { issues: { nodes: [issue], pageInfo: { hasNextPage: false } } } });
    if (query.includes('issueUpdate')) { operations.push('update'); return json({ data: { issueUpdate: { success: true } } }); }
    if (query.includes('attachmentCreate')) { operations.push('attach'); return json({ data: { attachmentCreate: { success: true } } }); }
    throw new Error('Unexpected request');
  });
  await linear.sync(snapshot(), 'team1', 'Recorded blocker: checks_failing.', 'stalled');
  assert.deepEqual(operations, ['update', 'attach']); assert.equal(log.filter(x => x.write).length, 2);
});
test('Linear ignores archived and foreign-team attachments, reports duplicates, and chooses oldest', async t => {
  const issue = (id: string, createdAt: string, team = 'team', archivedAt: string | null = null) => ({ id, identifier: id, createdAt, archivedAt, description: '', team: { id: team, key: 'OSS' } });
  t.mock.method(globalThis, 'fetch', async () => json({ data: { attachmentsForURL: { nodes: [issue('new', NOW), issue('old', '2020-01-01T00:00:00Z'), issue('foreign', '2010-01-01T00:00:00Z', 'other'), issue('archived', '2000-01-01T00:00:00Z', 'team', NOW)].map(issue => ({ issue })), pageInfo: { hasNextPage: false } } } }));
  const result = await new Linear('token', []).lookup(snapshot(), 'team'); assert.equal(result.issue?.id, 'old'); assert.deepEqual(result.duplicates, ['new']);
});
test('model receives structured blocker data only and omits unsupported Sonnet 5 temperature', async t => {
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.temperature, undefined); assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(JSON.parse(body.messages[0].content), { kind: 'merge_conflict', artifacts: ['main'], dates: [] });
    return json({ content: [{ type: 'thinking', text: 'ignored' }, { type: 'text', text: 'Your branch conflicts with main.' }] });
  });
  assert.equal(await anthropicModel('token', 'claude-sonnet-5', [])({ kind: 'merge_conflict', artifacts: ['main'], dates: [] }), 'Your branch conflicts with main.');
});
test('missing Slack ledger can be created despite a fresh inspection timestamp', async t => {
  const slack = new Slack('token', 'BOT', []); let stored: any = null;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const method = new URL(String(input)).pathname.split('/').at(-1)!;
    if (method === 'pins.list') return json({ ok: true, items: stored ? [{ message: stored }] : [] });
    if (method === 'chat.postMessage') { const body = JSON.parse(String(init?.body)); stored = { ts: '1.0', user: 'BOT', text: body.text }; return json({ ok: true, ts: '1.0' }); }
    if (method === 'pins.add') return json({ ok: true });
    if (method === 'chat.update') { stored.text = JSON.parse(String(init?.body)).text; return json({ ok: true }); }
    throw new Error(`Unexpected Slack call ${method}`);
  });
  const read = { ledger: emptyLedger(NOW), ts: null, paused: false, busy: false, ignored: 0 };
  assert.equal((await slack.acquire(read, config, 'holder', NOW)).ledger.lock?.holder, 'holder');
});
