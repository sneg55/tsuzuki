import { GitHub, pause, status } from './github.js';
import { repoParts } from './config.js';
import { parseMarker } from './marker.js';
import type { Snapshot } from './types.js';
export function patchOffset(patch: string): number | null {
  const match = /^Date:.* ([+-])(\d{2})(\d{2})\s*$/m.exec(patch);
  if (!match || +match[2]! > 14 || +match[3]! > 59 || (+match[2]! === 14 && +match[3]! !== 0)) return null;
  return (match[1] === '-' ? -1 : 1) * (+match[2]! * 60 + +match[3]!);
}
export async function snapshots(github: GitHub, repo: string): Promise<Snapshot[]> {
  const params = repoParts(repo);
  const pulls = await github.list('GET /repos/{owner}/{repo}/pulls', { ...params, state: 'open' });
  const protection = new Map<string, { names: string[]; unavailable: boolean }>();
  const result: Snapshot[] = [];
  for (const p of pulls) {
    let pull = await github.call('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...params, pull_number: p.number });
    let polls = 0;
    while (pull.mergeable === null && polls < 3) {
      await pause(2_000); polls++;
      pull = await github.call('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...params, pull_number: p.number });
    }
    if (!protection.has(pull.base.ref)) {
      try {
        const rule = await github.call('GET /repos/{owner}/{repo}/branches/{branch}/protection', { ...params, branch: pull.base.ref });
        protection.set(pull.base.ref, { names: [...new Set<string>([...(rule.required_status_checks?.contexts ?? []), ...(rule.required_status_checks?.checks ?? []).map((x: any) => x.context)])], unavailable: false });
      } catch (error) {
        if (![403, 404].includes(status(error) ?? 0)) throw error;
        protection.set(pull.base.ref, { names: [], unavailable: true });
      }
    }
    const commit = await github.call('GET /repos/{owner}/{repo}/commits/{ref}', { ...params, ref: pull.head.sha });
    let offset: number | null = null;
    try { offset = patchOffset(await github.call<string>('GET /repos/{owner}/{repo}/commits/{ref}', { ...params, ref: pull.head.sha, headers: { accept: 'application/vnd.github.patch' } })); }
    catch (error) { if (![406, 415, 422].includes(status(error) ?? 0)) throw error; }
    const checks = await github.list('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...params, ref: pull.head.sha, filter: 'latest' });
    const allStatuses = await github.list('GET /repos/{owner}/{repo}/commits/{ref}/statuses', { ...params, ref: pull.head.sha });
    const latestStatuses = new Map<string, { context: string; state: string }>();
    for (const s of allStatuses) if (!latestStatuses.has(s.context)) latestStatuses.set(s.context, { context: s.context, state: s.state });
    const reviews = await github.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...params, pull_number: p.number });
    const timeline = await github.list('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', { ...params, issue_number: p.number });
    const comments = await github.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...params, issue_number: p.number });
    const rule = protection.get(pull.base.ref)!;
    result.push({ repo, number: p.number, html_url: pull.html_url, draft: Boolean(pull.draft), labels: pull.labels.map((x: any) => x.name),
      author: pull.user.login, author_type: pull.user.type, base_ref: pull.base.ref, updated_at: pull.updated_at,
      mergeable: pull.mergeable, mergeability_polls: polls, head_sha: pull.head.sha, head_committed_at: commit.commit.committer.date, head_tz_offset: offset,
      checks: checks.map(x => ({ name: x.name, status: x.status, conclusion: x.conclusion, started_at: x.started_at })),
      statuses: [...latestStatuses.values()], required_checks: rule.names, protection_unavailable: rule.unavailable,
      reviews: reviews.map(x => ({ author: x.user?.login ?? '', author_type: x.user?.type ?? '', state: x.state, submitted_at: x.submitted_at ?? '', commit_id: x.commit_id })),
      timeline: timeline.map(x => ({ event: x.event, actor: x.actor?.login ?? '', actor_type: x.actor?.type ?? '', at: x.created_at ?? '' })),
      comments: comments.filter(x => x.user?.login === github.login).map(x => ({ id: x.id, created_at: x.created_at, marker: parseMarker(x.body ?? '') })),
    });
  }
  return result;
}
