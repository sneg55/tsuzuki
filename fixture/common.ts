import { readFile } from 'node:fs/promises';
import { GitHub, pause } from '../src/github.js';
import { clients, env, saveJSON } from '../src/runtime.js';
import { repoParts, type Config } from '../src/config.js';
import type { RequestEntry } from '../src/types.js';
export const REQUIRED = ['ci / test (ubuntu)', 'ci / required-queue'];
export const AUXILIARY = 'ci / contributor-check';
export type SeededCheck = { name: string; conclusion: 'success' | 'failure' | null };
export type FixtureState = {
  version: 1; repo: string; maintainer: string; contributor: string; bot: string;
  main_sha: string; ledger_ts: string; config: Config;
  pulls: { number: number; branch: string; sha: string; checks: SeededCheck[] }[];
};
export function fixtureClients() {
  const app = clients();
  const tokens = [env('GITHUB_TOKEN'), env('FIXTURE_MAINTAINER_GITHUB_TOKEN'), env('FIXTURE_CONTRIBUTOR_GITHUB_TOKEN'), env('FIXTURE_SEED_GITHUB_TOKEN')];
  if (new Set(tokens).size !== tokens.length) throw new Error('Agent, maintainer, contributor, and check-seeding credentials must be distinct');
  if (env('FIXTURE_SLACK_USER_TOKEN') === env('SLACK_BOT_TOKEN')) throw new Error('Fixture Slack user token must differ from bot token');
  const log: RequestEntry[] = [];
  return { app, log,
    maintainer: new GitHub(tokens[1]!, '', log, false, true),
    contributor: new GitHub(tokens[2]!, '', log, false, true),
    seeder: new GitHub(tokens[3]!, '', log, false, true),
  };
}
export type FixtureClients = ReturnType<typeof fixtureClients>;
export async function readState(path: string, repo?: string): Promise<FixtureState> {
  const state = JSON.parse(await readFile(path, 'utf8')) as FixtureState;
  if (state.version !== 1 || (repo && state.repo !== repo) || state.pulls.length !== 10 || !state.pulls.every((x, i) => x.number === i + 1 && x.branch === `fixture/pr-${i + 1}`)) throw new Error('Invalid or mismatched fixture manifest');
  repoParts(state.repo);
  return state;
}
export function commitDate(): string {
  const now = new Date();
  // Fixed fixture identities use an explicit offset with a daytime local clock at seed/reset.
  const offset = 12 - now.getUTCHours();
  const local = new Date(now.getTime() + offset * 3_600_000).toISOString().slice(0, -1);
  return `${local}${offset >= 0 ? '+' : '-'}${String(Math.abs(offset)).padStart(2, '0')}:00`;
}
export async function commit(gh: GitHub, repo: string, parent: string, files: Record<string, string>, author: string): Promise<string> {
  const p = repoParts(repo);
  const base = await gh.call('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { ...p, commit_sha: parent });
  const tree = await gh.call('POST /repos/{owner}/{repo}/git/trees', { ...p, base_tree: base.tree.sha, tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) });
  const created = await gh.call('POST /repos/{owner}/{repo}/git/commits', { ...p, message: 'Tsuzuki fixture state', tree: tree.sha, parents: [parent], author: { name: author, email: `${author}@users.noreply.github.com`, date: commitDate() } });
  return created.sha;
}
export async function setRef(gh: GitHub, repo: string, branch: string, sha: string): Promise<void> {
  await gh.call('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { ...repoParts(repo), ref: `heads/${branch}`, sha, force: true });
}
export async function seedChecks(ctx: FixtureClients, repo: string, sha: string, checks: SeededCheck[]): Promise<void> {
  for (const check of checks) {
    const data = await ctx.seeder.call('POST /repos/{owner}/{repo}/check-runs', {
      ...repoParts(repo), head_sha: sha, name: check.name,
      status: check.conclusion ? 'completed' : 'queued', started_at: new Date().toISOString(),
      ...(check.conclusion ? { conclusion: check.conclusion, completed_at: new Date().toISOString() } : {}),
    });
    if (`${data.app.slug}[bot]` === ctx.app.github.login) throw new Error('Seeding app must not be the agent app');
  }
}
export async function ready(ctx: FixtureClients, state: Pick<FixtureState, 'repo' | 'pulls'>): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    let complete = true;
    for (const pr of state.pulls) {
      const pull = await ctx.maintainer.call('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...repoParts(state.repo), pull_number: pr.number });
      const checks = await ctx.seeder.list('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...repoParts(state.repo), ref: pull.head.sha, filter: 'latest' });
      if (pull.head.sha !== pr.sha || pull.mergeable === null || checks.length !== pr.checks.length || !pr.checks.every(expected => checks.some(x => x.name === expected.name && x.conclusion === expected.conclusion && (expected.conclusion !== null || (x.status === 'queued' && x.started_at))))) complete = false;
    }
    if (complete) return;
    await pause(2_000);
  }
  throw new Error('Fixture readiness gate exhausted: head, mergeability, or declared checks not ready');
}
export async function pushTo(ctx: FixtureClients, state: FixtureState, numbers: number[]): Promise<void> {
  const changed: FixtureState['pulls'] = [];
  for (const number of numbers) {
    if (![4, 7, 9].includes(number)) throw new Error('push_to only supports fixture PRs 4, 7, and 9');
    const seeded = state.pulls.find(x => x.number === number)!;
    const pull = await ctx.contributor.call('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...repoParts(state.repo), pull_number: number });
    const sha = await commit(ctx.contributor, state.repo, pull.head.sha, { [`moves/${number}.txt`]: `Move ${crypto.randomUUID()}\n` }, state.contributor);
    await setRef(ctx.contributor, state.repo, seeded.branch, sha);
    const checks: SeededCheck[] = number === 7 ? [] : REQUIRED.map((name, index) => ({ name, conclusion: number === 4 && index === 0 ? 'failure' : 'success' }));
    await seedChecks(ctx, state.repo, sha, checks);
    changed.push({ ...seeded, sha, checks });
  }
  await ready(ctx, { repo: state.repo, pulls: changed });
}
export async function fixtureIdentityCheck(ctx: FixtureClients, state?: FixtureState): Promise<{ maintainer: string; contributor: string; slackUser: string }> {
  const maintainer = (await ctx.maintainer.call('GET /user')).login;
  const contributor = (await ctx.contributor.call('GET /user')).login;
  const slackUser = (await ctx.app.slack.call('auth.test', {}, env('FIXTURE_SLACK_USER_TOKEN'))).user_id;
  if (maintainer === contributor || maintainer === ctx.app.github.login || contributor === ctx.app.github.login) throw new Error('Fixture human identities must be distinct from each other and the agent');
  if (state && (maintainer !== state.maintainer || contributor !== state.contributor || ctx.app.github.login !== state.bot || !state.config.slack.maintainers.includes(slackUser))) throw new Error('Fixture credentials do not match the seeded identities');
  return { maintainer, contributor, slackUser };
}
