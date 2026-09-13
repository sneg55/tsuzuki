import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands, compareTs, decodeLedger, emptyLedger, encodeLedger } from '../src/ledger.js';
import { NOW } from './helpers.js';
test('ledger is validated and round-trips without losing durable suppressions', () => {
  const ledger = emptyLedger(NOW); ledger.repos['owner/repo'] = { prs: [7], logins: ['alice'] };
  assert.deepEqual(decodeLedger(encodeLedger(ledger)), ledger);
  assert.throws(() => decodeLedger('Tsuzuki suppression ledger v1\n```\n{}\n```'));
});
test('commands merge in global timestamp order, authorize humans, and skip self-authored commands', () => {
  const result = applyCommands(emptyLedger(NOW), [
    { ts: '10.000002', user: 'UADMIN', text: 'unskip #7', repo: 'owner/repo' },
    { ts: '10.000001', user: 'UADMIN', text: 'skip owner/repo#7' },
    { ts: '10.000003', user: 'OTHER', text: 'skip #4', repo: 'owner/repo' },
    { ts: '10.000004', user: 'BOT', text: 'skip #9', repo: 'owner/repo' },
    { ts: '10.000005', user: 'UADMIN', text: 'skip @Alice', repo: 'owner/repo' },
  ], ['UADMIN'], 'BOT', NOW);
  assert.deepEqual(result.ledger.repos['owner/repo'], { prs: [], logins: ['alice'] }); assert.equal(result.ignored, 1); assert.equal(result.ledger.cursor, '10.000005');
  const replay = applyCommands(result.ledger, [{ ts: '10.000001', user: 'UADMIN', text: 'skip owner/repo#7' }], ['UADMIN'], 'BOT', NOW);
  assert.equal(replay.changed, false);
});
test('ledger thread commands require a repository; digest commands remain scoped', () => {
  const result = applyCommands(emptyLedger(NOW), [{ ts: '1.1', user: 'UADMIN', text: 'skip #7' }, { ts: '1.2', user: 'UADMIN', text: 'skip #7', repo: 'other/repo' }], ['UADMIN'], 'BOT', NOW);
  assert.equal(result.ignored, 1); assert.deepEqual(result.ledger.repos, { 'other/repo': { prs: [7], logins: [] } });
});
test('Slack timestamp comparison retains fractional precision', () => {
  assert.equal(compareTs('1757800000.000100', '1757800000.000101'), -1);
  assert.equal(compareTs('10.100', '10.1'), 0);
  assert.equal(compareTs('11.0', '10.999999'), 1);
});
