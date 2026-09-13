export const blockerKinds = ['cla_pending', 'checks_failing', 'merge_conflict', 'changes_requested'] as const;
export type BlockerKind = typeof blockerKinds[number];
export type Blocker = { kind: BlockerKind; artifacts: string[]; dates: (string | null)[] };
export type Signal = { kind: 'checks_pending' | 'mergeability_unknown'; artifacts: string[]; detail: string };
export type Marker = { blocker: BlockerKind; checks: string[]; also: BlockerKind[]; head_sha: string };
export type Check = { name: string; status: string; conclusion: string | null; started_at: string | null };
export type Review = { author: string; author_type: string; state: string; submitted_at: string; commit_id: string };
export type Snapshot = {
  repo: string; number: number; html_url: string; draft: boolean; labels: string[];
  author: string; author_type: string; base_ref: string; updated_at: string;
  mergeable: boolean | null; mergeability_polls: number; head_sha: string;
  head_committed_at: string; head_tz_offset: number | null;
  checks: Check[]; statuses: { context: string; state: string }[];
  required_checks: string[]; protection_unavailable: boolean; reviews: Review[];
  timeline: { event: string; actor: string; actor_type: string; at: string }[];
  comments: { id: number; created_at: string; marker: Marker | null }[];
};
export type Suppressions = { prs: number[]; logins: string[] };
export type Ledger = {
  paused: boolean; cursor: string | null; lock: { holder: string; at: string } | null;
  repos: Record<string, Suppressions>; updated: string;
};
export type Analysis = { skip: string | null; blockers: Blocker[]; signals: Signal[]; court: 'contributor' | 'maintainer' | 'unsure' | null };
export type Decision = Analysis & { nudge: boolean; reason: string; local_hour: number | null; timezone_unavailable: boolean; add_labels: string[]; remove_labels: string[] };
export type Outcome = 'pending' | 'cleared' | 'pushed' | 'stalled';
export type RequestEntry = { app: 'github' | 'slack' | 'linear' | 'anthropic'; method: string; path: string; at: string; write: boolean };
export type RunRow = { number: number; decision: Decision; outcome?: Outcome; sentence?: string; fallback?: boolean; nudged: boolean; errors: string[]; duplicates: string[] };
