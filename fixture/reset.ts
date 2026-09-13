import { pathToFileURL } from 'node:url';
import { fixtureClients, fixtureIdentityCheck, readState, ready, setRef, AUXILIARY, type FixtureClients, type FixtureState } from './common.js';
import { args, env } from '../src/runtime.js';
import { repoParts } from '../src/config.js';
import { emptyLedger } from '../src/ledger.js';
import { markerLine } from '../src/marker.js';
export async function reset(state: FixtureState, ctx: FixtureClients = fixtureClients()): Promise<void> {
  await fixtureIdentityCheck(ctx, state);
  const p = repoParts(state.repo);
  const declaration = await ctx.maintainer.call('GET /repos/{owner}/{repo}/contents/{path}', { ...p, path: '.tsuzuki-fixture.json', ref: 'main' });
  const identity = JSON.parse(Buffer.from(declaration.content, 'base64').toString('utf8'));
  if (identity.maintainer !== state.maintainer || identity.contributor !== state.contributor || identity.bot !== state.bot) throw new Error('Repository is not this dedicated fixture');
  for (const pr of state.pulls) {
    const pull = await ctx.maintainer.call('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...p, pull_number: pr.number });
    if (pull.head.ref !== pr.branch || pull.head.repo.full_name !== state.repo || pull.state !== 'open' || pull.merged) throw new Error(`Fixture PR #${pr.number} changed outside the reset contract`);
    await setRef(ctx.maintainer, state.repo, pr.branch, pr.sha);
    const comments = await ctx.maintainer.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...p, issue_number: pr.number });
    for (const comment of comments.filter(x => x.user.login === state.bot)) await ctx.maintainer.call('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', { ...p, comment_id: comment.id });
    for (const label of pull.labels.filter((x: any) => ['tsuzuki:contributor', 'tsuzuki:maintainer'].includes(x.name))) await ctx.maintainer.call('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...p, issue_number: pr.number, name: label.name });
  }
  await ctx.app.github.call('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...p, issue_number: 3, body: `${AUXILIARY} is failing; please check the reported results.\n\n${markerLine({ blocker: 'checks_failing', checks: [AUXILIARY], also: [], head_sha: state.pulls[2]!.sha })}` });
  const channel = state.config.slack.channel;
  const history = await ctx.app.slack.messages('conversations.history', { channel });
  for (const parent of history.filter(x => x.user === ctx.app.slack.bot)) {
    const replies = await ctx.app.slack.messages('conversations.replies', { channel, ts: parent.ts });
    for (const reply of replies.filter(x => x.ts !== parent.ts)) {
      if (reply.user !== ctx.app.slack.bot && !state.config.slack.maintainers.includes(reply.user ?? '')) throw new Error('Unexpected participant in fixture Slack thread; reset will not remove their message');
      await ctx.app.slack.call('chat.delete', { channel, ts: reply.ts }, reply.user === ctx.app.slack.bot ? undefined : env('FIXTURE_SLACK_USER_TOKEN'));
    }
    if (parent.ts !== state.ledger_ts) await ctx.app.slack.call('chat.delete', { channel, ts: parent.ts });
  }
  const reaction = await ctx.app.slack.call('reactions.get', { channel, timestamp: state.ledger_ts, full: true });
  const pause = reaction.message?.reactions?.find((x: any) => x.name === 'no_entry_sign');
  if (pause) {
    const identity = await ctx.app.slack.call('auth.test', {}, env('FIXTURE_SLACK_USER_TOKEN'));
    if (pause.users.some((x: string) => x !== identity.user_id)) throw new Error('Pause includes a reaction from an identity the reset cannot control');
    await ctx.app.slack.call('reactions.remove', { channel, timestamp: state.ledger_ts, name: 'no_entry_sign' }, env('FIXTURE_SLACK_USER_TOKEN'));
  }
  await ctx.app.slack.save(channel, state.ledger_ts, emptyLedger(new Date().toISOString()));
  const teamId = await ctx.app.linear.team(state.config.linear.team_key);
  for (const issue of await ctx.app.linear.issues(teamId, `tsuzuki-pr: ${state.repo}#`)) {
    if (state.pulls.some(pr => issue.description?.split('\n').includes(`tsuzuki-pr: ${state.repo}#${pr.number}`))) await ctx.app.linear.query('issueArchive', 'mutation Archive($id:String!) { issueArchive(id:$id) { success } }', { id: issue.id });
  }
  await ready(ctx, state);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = args({ state: { type: 'string' } });
  if (options['dry-run']) throw new Error('Fixture reset has no dry-run mode');
  readState(String(options.state ?? 'fixture/state.json'), options.repo as string | undefined).then(state => reset(state)).then(() => console.log('Fixture restored across GitHub, Slack, and Linear.')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
