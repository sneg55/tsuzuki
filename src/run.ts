import { randomUUID } from 'node:crypto';
import { analyze } from './blocker.js';
import { decide } from './policy.js';
import { snapshots } from './snapshot.js';
import { makeMarker, markerLine } from './marker.js';
import { measure } from './outcome.js';
import { phrase, template, validateSentence, type PhraseModel } from './phrase.js';
import { digest } from './digest.js';
import { repoParts, type Config } from './config.js';
import type { GitHub } from './github.js';
import type { Slack, LedgerRead } from './slack.js';
import type { Linear } from './linear.js';
import type { Ledger, RequestEntry, RunRow, Snapshot } from './types.js';
export type RunResult = {
  id: string; repo: string; now: string; dry_run: boolean; status: 'ok' | 'paused' | 'busy' | 'unwatched' | 'error';
  config?: Config; ledger?: Ledger; snapshots: Snapshot[]; rows: RunRow[]; requests: RequestEntry[]; digest: string; errors: string[];
};
export type Dependencies = { github: GitHub; slack: Slack; linear: Linear; log: RequestEntry[]; model?: PhraseModel; createModel?: (model: string) => PhraseModel };
export async function run(repo: string, deps: Dependencies, options: { dryRun?: boolean; now?: string } = {}): Promise<RunResult> {
  const { github, slack, linear } = deps;
  const now = options.now ?? new Date().toISOString(); const id = `run-${randomUUID()}`; const dryRun = options.dryRun ?? false;
  const result: RunResult = { id, repo, now, dry_run: dryRun, status: 'ok', snapshots: [], rows: [], requests: deps.log, digest: '', errors: [] };
  let locked: LedgerRead | undefined;
  try {
    if (dryRun && (!github.dryRun || !slack.dryRun || !linear.dryRun)) throw new Error('Dry-run clients must enforce read-only access');
    const config = await github.config(repo);
    if (!config) { result.status = 'unwatched'; result.digest = `Tsuzuki: ${repo} is not watched (no .github/tsuzuki.yml).`; return result; }
    result.config = config;
    const read = await slack.inspect(config, now);
    if (read.paused) {
      result.status = 'paused'; result.ledger = read.ledger; result.digest = `Tsuzuki, ${repo}: paused.`;
      if (!dryRun) await slack.post(config.slack.channel, result.digest);
      return result;
    }
    if (read.busy) { result.status = 'busy'; result.digest = `Tsuzuki, ${repo}: another run holds the ledger lock.`; return result; }
    // Complete all GitHub reads before taking the ledger lock or issuing any provider write.
    result.snapshots = await snapshots(github, repo);
    const labels = (await github.list('GET /repos/{owner}/{repo}/labels', repoParts(repo))).map(x => x.name as string);
    const teamId = await linear.team(config.linear.team_key);
    locked = await slack.acquire(read, config, id, now);
    const commands = await slack.commands(locked, config, now);
    if (!dryRun && commands.ts && JSON.stringify(commands.ledger) !== JSON.stringify(locked.ledger)) await slack.save(config.slack.channel, commands.ts, commands.ledger);
    locked = commands; result.ledger = structuredClone(commands.ledger);
    if (!dryRun) await github.ensureLabels(repo, labels);
    for (const pr of result.snapshots) {
      const analysis = analyze(pr, config, commands.ledger.repos[repo] ?? { prs: [], logins: [] }, now);
      const decision = decide(pr, analysis, config, now);
      const row: RunRow = { number: pr.number, decision, nudged: false, errors: [], duplicates: [] };
      result.rows.push(row);
      const previous = pr.comments.filter(x => x.marker && Date.parse(x.created_at) < Date.parse(now)).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
      if (previous?.marker) row.outcome = measure(pr, analysis, previous.marker);
      if (decision.nudge) {
        const phrased = await phrase(analysis.blockers, deps.model ?? deps.createModel?.(config.phrase.model));
        row.fallback = phrased.fallback;
        if (!phrased.sentence) { row.decision = { ...decision, nudge: false, reason: 'unphrasable' }; }
        else {
          row.sentence = phrased.sentence;
          try {
            if (!dryRun) await github.comment(pr, `${phrased.sentence}\n\n${markerLine(makeMarker(analysis.blockers, pr.head_sha))}`);
            row.nudged = true;
          } catch { row.errors.push('GitHub comment failed'); row.decision = { ...row.decision, nudge: false, reason: 'write_failed' }; }
        }
      }
      try { if (!dryRun) await github.labels(pr, decision.add_labels, decision.remove_labels); }
      catch { row.errors.push('GitHub court label update failed'); }
      // Prior markers repair a missing mirror without creating another GitHub comment.
      if (row.nudged || previous?.marker) {
        let sentence = row.sentence;
        if (!sentence && previous?.marker) {
          const current = analysis.blockers.find(x => x.kind === previous.marker!.blocker);
          sentence = current && validateSentence(template(current), current) ? template(current) : `Recorded blocker: ${previous.marker.blocker}.`;
        }
        try { row.duplicates = await linear.sync(pr, teamId, sentence!, row.outcome); }
        catch { row.errors.push('Linear mirror failed'); }
      }
    }
    result.digest = digest(repo, now, result.rows, result.snapshots, commands.ignored, dryRun);
    if (!dryRun) await slack.post(config.slack.channel, result.digest);
    if (result.rows.some(x => x.errors.length)) result.status = 'error';
  } catch (error) {
    result.status = 'error'; result.errors.push(error instanceof Error ? error.message : 'Unknown run failure');
  } finally {
    if (locked && result.config && !dryRun) {
      try { await slack.release(locked, result.config, id); }
      catch { result.status = 'error'; result.errors.push('Slack lock release failed'); }
    }
  }
  return result;
}
