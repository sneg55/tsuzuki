import { isDeepStrictEqual } from 'node:util';
import { repoParts } from '../src/config.js';
import { COURT_LABELS } from '../src/github.js';
import type { FixtureClients, FixtureState } from '../fixture/common.js';
import type { LinearIssue } from '../src/linear.js';
import type { SlackMessage } from '../src/slack.js';
export type PullWitness = {
  number: number; state: string; merged: boolean; labels: string[]; assignees: string[]; milestone: number | null;
  base: { ref: string; sha: string }; head: { ref: string; sha: string }; branch_sha: string;
  reviews: unknown[]; timeline: any[]; comments: { id: number; user: string; body: string; created_at: string }[];
};
export type ProviderWitness = { pulls: PullWitness[]; slack: SlackMessage[]; slack_bot: string; linear: LinearIssue[] };
export async function witness(ctx: FixtureClients, state: FixtureState): Promise<ProviderWitness> {
  const p = repoParts(state.repo); const pulls: PullWitness[] = [];
  for (const pr of state.pulls) {
    const pull = await ctx.maintainer.call('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...p, pull_number: pr.number });
    const ref = await ctx.maintainer.call('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...p, ref: `heads/${pr.branch}` });
    const reviews = await ctx.maintainer.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...p, pull_number: pr.number });
    const timeline = await ctx.maintainer.list('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', { ...p, issue_number: pr.number });
    const comments = await ctx.maintainer.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...p, issue_number: pr.number });
    pulls.push({ number: pr.number, state: pull.state, merged: pull.merged, labels: pull.labels.map((x: any) => x.name).sort(),
      assignees: pull.assignees.map((x: any) => x.login).sort(), milestone: pull.milestone?.number ?? null,
      base: { ref: pull.base.ref, sha: pull.base.sha }, head: { ref: pull.head.ref, sha: pull.head.sha }, branch_sha: ref.object.sha,
      reviews, timeline, comments: comments.map(x => ({ id: x.id, user: x.user.login, body: x.body, created_at: x.created_at })) });
  }
  const channel = state.config.slack.channel;
  const history = await ctx.app.slack.messages('conversations.history', { channel });
  const messages: SlackMessage[] = [...history];
  for (const message of history.filter(x => x.reply_count)) messages.push(...(await ctx.app.slack.messages('conversations.replies', { channel, ts: message.ts })).filter(x => x.ts !== message.ts));
  const teamId = await ctx.app.linear.team(state.config.linear.team_key);
  return { pulls, slack: messages, slack_bot: ctx.app.slack.bot, linear: await ctx.app.linear.issues(teamId, `tsuzuki-pr: ${state.repo}#`) };
}
export function forbiddenChanges(before: ProviderWitness, after: ProviderWitness, bot: string): string[] {
  const violations: string[] = [];
  if (before.pulls.length !== after.pulls.length) violations.push('Pull request set changed');
  for (const prior of before.pulls) {
    const next = after.pulls.find(x => x.number === prior.number);
    if (!next) { violations.push(`#${prior.number} disappeared`); continue; }
    for (const key of ['state', 'merged', 'assignees', 'milestone', 'base', 'head', 'branch_sha', 'reviews'] as const)
      if (!isDeepStrictEqual(prior[key], next[key])) violations.push(`#${prior.number} changed ${key}`);
    if (!isDeepStrictEqual(prior.labels.filter(x => !COURT_LABELS.includes(x)), next.labels.filter(x => !COURT_LABELS.includes(x)))) violations.push(`#${prior.number} changed non-court labels`);
    for (const comment of prior.comments) if (!next.comments.some(x => isDeepStrictEqual(x, comment))) violations.push(`#${prior.number} modified or deleted a comment`);
    for (const comment of next.comments.filter(x => !prior.comments.some(y => y.id === x.id))) if (comment.user !== bot) violations.push(`#${prior.number} comment from another actor`);
    const eventKey = (event: any) => String(event.id ?? event.node_id ?? JSON.stringify(event));
    const oldEvents = new Map(prior.timeline.map(x => [eventKey(x), x]));
    const newEvents = new Map(next.timeline.map(x => [eventKey(x), x]));
    for (const [id, event] of oldEvents) if (!isDeepStrictEqual(event, newEvents.get(id))) violations.push(`#${prior.number} changed existing timeline event`);
    for (const [id, event] of newEvents) if (!oldEvents.has(id)) {
      const own = (event.actor?.login ?? event.user?.login) === bot;
      const allowed = own && (event.event === 'commented' || (['labeled', 'unlabeled'].includes(event.event) && COURT_LABELS.includes(event.label?.name)));
      if (!allowed) violations.push(`#${prior.number} forbidden timeline event: ${event.event}`);
    }
  }
  return violations;
}
