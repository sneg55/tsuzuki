import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/blocker.js';
import { decide } from '../src/policy.js';
import { measure } from '../src/outcome.js';
import { makeMarker, markerLine, parseMarker } from '../src/marker.js';
import { patchOffset } from '../src/snapshot.js';
import { configSchema, parseConfig } from '../src/config.js';
import { phrase, template, validateSentence } from '../src/phrase.js';
import { NOW, config, snapshot, failed } from './helpers.js';
import type { Blocker, Snapshot } from '../src/types.js';
const empty = { prs: [], logins: [] };
const analyzePR = (pr: Snapshot) => analyze(pr, config, empty, NOW);
const decision = (pr: Snapshot) => decide(pr, analyzePR(pr), config, NOW);
test('green, approved, and pushed-after-review PRs stay in maintainer court', () => {
  for (const reviews of [[], [{ author: 'reviewer', author_type: 'User', state: 'APPROVED', submitted_at: NOW, commit_id: 'abc123' }], [{ author: 'reviewer', author_type: 'User', state: 'CHANGES_REQUESTED', submitted_at: NOW, commit_id: 'previous' }]]) {
    const d = decision(snapshot({ reviews })); assert.equal(d.court, 'maintainer'); assert.equal(d.nudge, false);
  }
});
test('ordered skip reasons take precedence over blockers and leave labels untouched', () => {
  const cases: [Partial<Snapshot>, string][] = [[{ draft: true, author_type: 'Bot' }, 'draft'], [{ author_type: 'Bot' }, 'bot_author'], [{ author: 'dependabot[bot]' }, 'skip_author'], [{ labels: ['on-hold', 'tsuzuki:maintainer'] }, 'skipped_label']];
  for (const [overrides, skip] of cases) { const d = decision(snapshot({ checks: [failed], ...overrides })); assert.equal(d.skip, skip); assert.deepEqual(d.blockers, []); assert.deepEqual(d.remove_labels, []); assert.deepEqual(d.add_labels, []); }
  assert.equal(analyze(snapshot(), config, { prs: [4], logins: [] }, NOW).skip, 'never_contact');
  assert.equal(analyze(snapshot(), config, { prs: [], logins: ['CONTRIBUTOR'] }, NOW).skip, 'never_contact');
});
test('blockers form a stable priority-ordered set and use review SHA equality', () => {
  const pr = snapshot({ mergeable: false, checks: [failed, { ...failed, name: 'cla/signed', conclusion: null }], reviews: [{ author: 'reviewer', author_type: 'User', state: 'CHANGES_REQUESTED', submitted_at: NOW, commit_id: 'abc123' }] });
  const a = analyzePR(pr); assert.deepEqual(a.blockers.map(x => x.kind), ['cla_pending', 'checks_failing', 'merge_conflict', 'changes_requested']);
  assert.equal(a.court, 'contributor'); assert.deepEqual(a.signals, []);
  const marker = makeMarker(a.blockers, pr.head_sha); assert.equal(marker.blocker, 'cla_pending'); assert.equal(marker.also.length, 3);
});
test('latest human review wins; bot reviews never decide changes_requested', () => {
  const reviews = [{ author: 'reviewer', author_type: 'User', state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T12:00:00Z', commit_id: 'abc123' }, { author: 'bot', author_type: 'Bot', state: 'APPROVED', submitted_at: NOW, commit_id: 'abc123' }];
  assert.equal(analyzePR(snapshot({ reviews })).court, 'contributor');
  reviews.push({ author: 'human', author_type: 'User', state: 'DISMISSED', submitted_at: NOW, commit_id: 'abc123' });
  assert.equal(analyzePR(snapshot({ reviews })).court, 'maintainer');
});
test('legacy CLA statuses and ordinary failures are included, optional failures excluded', () => {
  const a = analyzePR(snapshot({ statuses: [{ context: 'license/cla', state: 'pending' }, { context: 'build', state: 'error' }], checks: [{ ...failed, name: 'codecov' }, { ...failed, name: '[optional] docs' }] }));
  assert.deepEqual(a.blockers.map(x => x.kind), ['cla_pending', 'checks_failing']);
  assert.deepEqual(a.blockers[1]?.artifacts, ['build']);
});
test('only old required queued checks with a real started_at yield unsure', () => {
  const check = { ...failed, name: 'required', status: 'queued', conclusion: null };
  assert.equal(analyzePR(snapshot({ checks: [check], required_checks: ['required'] })).court, 'unsure');
  assert.equal(analyzePR(snapshot({ checks: [check] })).court, 'maintainer');
  assert.equal(analyzePR(snapshot({ checks: [{ ...check, started_at: null }], required_checks: ['required'] })).court, 'maintainer');
  assert.equal(analyzePR(snapshot({ checks: [{ ...check, started_at: NOW }], required_checks: ['required'] })).court, 'maintainer');
});
test('unknown mergeability is unsure unless a named blocker establishes contributor court', () => {
  assert.equal(analyzePR(snapshot({ mergeable: null })).court, 'unsure');
  assert.equal(analyzePR(snapshot({ mergeable: null, checks: [failed] })).court, 'contributor');
});
test('fresh server activity wins over arbitrary commit dates and bot timeline events', () => {
  assert.equal(decision(snapshot({ checks: [failed], updated_at: NOW })).reason, 'fresh_activity');
  assert.equal(decision(snapshot({ checks: [failed], timeline: [{ event: 'reviewed', actor: 'human', actor_type: 'User', at: NOW }] })).reason, 'fresh_activity');
  assert.equal(decision(snapshot({ checks: [failed], timeline: [{ event: 'commented', actor: 'bot', actor_type: 'Bot', at: NOW }] })).nudge, true);
});
test('frequency cap trusts every own comment server timestamp, even an invalid marker', () => {
  const pr = snapshot({ checks: [failed], comments: [{ id: 1, created_at: NOW, marker: null }] });
  assert.equal(decision(pr).reason, 'frequency_cap');
  assert.deepEqual(decision(pr).add_labels, ['tsuzuki:contributor']);
});
test('quiet-hour windows wrap, same endpoints disable the window, missing offset is disclosed', () => {
  assert.equal(decision(snapshot({ checks: [failed], head_tz_offset: 600 })).reason, 'quiet_hours');
  const pr = snapshot({ checks: [failed], head_tz_offset: null }); assert.equal(decision(pr).nudge, true); assert.equal(decision(pr).timezone_unavailable, true);
  const c = { ...config, quiet_hours: { start: 0, end: 0 } }; assert.equal(decide(pr, analyzePR(pr), c, NOW).nudge, true);
  const daytime = { ...config, quiet_hours: { start: 10, end: 18 } }; assert.equal(decide(snapshot({ checks: [failed] }), analyzePR(snapshot({ checks: [failed] })), daytime, NOW).reason, 'quiet_hours');
});
test('court labels are diffed, do not depend on comment gates, and are removed for unsure', () => {
  assert.deepEqual(decision(snapshot({ checks: [failed], labels: ['tsuzuki:contributor'] })).add_labels, []);
  const d = decision(snapshot({ labels: ['tsuzuki:contributor', 'other'] })); assert.deepEqual(d.remove_labels, ['tsuzuki:contributor']); assert.deepEqual(d.add_labels, ['tsuzuki:maintainer']);
  const unsure = decision(snapshot({ mergeable: null, labels: ['tsuzuki:maintainer'] })); assert.deepEqual(unsure.remove_labels, ['tsuzuki:maintainer']); assert.deepEqual(unsure.add_labels, []);
});
test('outcomes distinguish unreported, cleared, pushed and stalled with primary-only comparison', () => {
  const original = snapshot({ checks: [failed], mergeable: false }); const marker = makeMarker(analyzePR(original).blockers, original.head_sha);
  const cases: [Snapshot, string][] = [[snapshot({ head_sha: 'new' }), 'pending'], [snapshot({ head_sha: 'new', checks: [{ ...failed, conclusion: null, status: 'queued' }] }), 'pending'], [snapshot({ checks: [{ ...failed, conclusion: 'success' }], mergeable: false }), 'cleared'], [snapshot({ head_sha: 'new', checks: [failed] }), 'pushed'], [original, 'stalled'], [snapshot({ checks: [failed], mergeable: null }), 'pending']];
  for (const [pr, outcome] of cases) assert.equal(measure(pr, analyzePR(pr), marker), outcome);
  assert.equal(measure(original, analyze(original, config, { prs: [4], logins: [] }, NOW), marker), 'pending');
});
test('marker parser rejects malformed payloads and uses only a final protocol marker', () => {
  const marker = makeMarker(analyzePR(snapshot({ checks: [failed] })).blockers, 'abc123');
  assert.deepEqual(parseMarker(`Sentence.\n${markerLine(marker)}`), marker);
  assert.equal(parseMarker(`${markerLine(marker)}\nMore text`), null);
  assert.equal(parseMarker('<!-- tsuzuki v1 {"blocker":"close"} -->'), null);
});
test('patch offset preserves contributor offset and rejects malformed dates', () => {
  assert.equal(patchOffset('Date: Sun, 13 Sep 2026 15:50:52 +0230\n'), 150);
  assert.equal(patchOffset('Date: Sun, 13 Sep 2026 15:50:52 -0530\n'), -330);
  assert.equal(patchOffset('Date: Sun, 13 Sep 2026 15:50:52 +1499\n'), null);
  assert.equal(patchOffset('no Date header'), null);
});
test('all four fallback templates validate and preserve dotted artifact names', async () => {
  const blockers: Blocker[] = [{ kind: 'cla_pending', artifacts: ['cla/signed'], dates: [] }, { kind: 'checks_failing', artifacts: ['ci.test', 'build', 'lint'], dates: [NOW] }, { kind: 'merge_conflict', artifacts: ['release/1.0'], dates: [] }, { kind: 'changes_requested', artifacts: ['reviewer'], dates: [NOW] }];
  for (const blocker of blockers) { assert.equal(validateSentence(template(blocker), blocker), true); const result = await phrase([blocker], async () => { throw new Error('Model unavailable'); }); assert.equal(result.fallback, true); assert.equal(result.sentence, template(blocker)); }
});
test('invalid model outputs fall back; impossible artifacts withhold the comment', async () => {
  const blocker: Blocker = { kind: 'merge_conflict', artifacts: ['main'], dates: [] };
  for (const output of ['Please merge main.', 'main conflicts. Do another thing.', 'Wrong artifact.', 'main\nconflicts.', 'main <script>.']) assert.equal((await phrase([blocker], async () => output)).fallback, true);
  const good = 'Your branch conflicts with main; please resolve the conflicts.';
  assert.deepEqual(await phrase([blocker], async () => good), { sentence: good, fallback: false });
  assert.equal((await phrase([{ ...blocker, artifacts: ['x'.repeat(210)] }])).sentence, null);
});
test('configuration errors fail closed, including a disabled never_close', () => {
  assert.throws(() => configSchema.parse({ ...config, never_close: false }));
  assert.throws(() => configSchema.parse({ ...config, optional_check_patterns: ['['] }));
  assert.throws(() => parseConfig('nudge_after_days: nope'));
  assert.throws(() => configSchema.parse({ ...config, labels: { ...config.labels, contributor: 'other' } }));
});
test('pure decisions are byte-identical over repeated recorded inputs', () => {
  const pr = snapshot({ checks: [failed] }); const first = JSON.stringify(decision(pr));
  for (let i = 0; i < 100; i++) assert.equal(JSON.stringify(decision(pr)), first);
});
