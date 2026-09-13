import { z } from 'zod';
import type { Ledger } from './types.js';
export const LEDGER_TITLE = 'Tsuzuki suppression ledger v1';
const schema = z.object({
  paused: z.boolean(), cursor: z.string().regex(/^\d+\.\d+$/).nullable(),
  lock: z.object({ holder: z.string(), at: z.iso.datetime() }).nullable(),
  repos: z.record(z.string(), z.object({ prs: z.array(z.number().int().positive()), logins: z.array(z.string()) })),
  updated: z.iso.datetime(),
}).strict();
export function emptyLedger(now: string): Ledger { return { paused: false, cursor: null, lock: null, repos: {}, updated: now }; }
export function encodeLedger(ledger: Ledger): string { return `${LEDGER_TITLE}\n\`\`\`\n${JSON.stringify(ledger, null, 2)}\n\`\`\``; }
export function decodeLedger(text: string): Ledger {
  const match = /^Tsuzuki suppression ledger v1\n```\n([\s\S]+)\n```$/.exec(text);
  if (!match) throw new Error('Malformed pinned suppression ledger');
  return schema.parse(JSON.parse(match[1]!));
}
export function compareTs(a: string, b: string): number {
  const [as, af = ''] = a.split('.'); const [bs, bf = ''] = b.split('.');
  const seconds = BigInt(as!) - BigInt(bs!);
  return seconds < 0n ? -1 : seconds > 0n ? 1 : af.padEnd(9, '0').localeCompare(bf.padEnd(9, '0'));
}
export type Reply = { ts: string; user?: string; text?: string; repo?: string };
export function applyCommands(ledger: Ledger, replies: Reply[], maintainers: string[], bot: string, now: string): { ledger: Ledger; ignored: number; changed: boolean } {
  const next = structuredClone(ledger); let ignored = 0;
  const unique = [...new Map(replies.map(x => [x.ts, x])).values()].sort((a, b) => compareTs(a.ts, b.ts));
  for (const reply of unique) {
    if (ledger.cursor && compareTs(reply.ts, ledger.cursor) <= 0) continue;
    next.cursor = reply.ts;
    if (reply.user === bot) continue;
    const text = reply.text?.trim() ?? '';
    if (!/^(unskip|skip)\b/.test(text)) continue;
    if (!reply.user || !maintainers.includes(reply.user)) { ignored++; continue; }
    const match = /^(skip|unskip) (?:(?<repo>[\w.-]+\/[\w.-]+))?(?<target>#[1-9]\d*|@[\w-]+)$/.exec(text);
    const repo = match?.groups?.repo ?? reply.repo;
    if (!match || !repo) { ignored++; continue; }
    const target = match.groups!.target!;
    const set = next.repos[repo] ??= { prs: [], logins: [] };
    const remove = match[1] === 'unskip';
    if (target.startsWith('#')) {
      const n = Number(target.slice(1));
      if (!Number.isSafeInteger(n)) { ignored++; continue; }
      set.prs = remove ? set.prs.filter(x => x !== n) : [...new Set([...set.prs, n])].sort((a, b) => a - b);
    } else {
      const login = target.slice(1).toLowerCase();
      set.logins = remove ? set.logins.filter(x => x.toLowerCase() !== login) : [...new Set([...set.logins, login])].sort();
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(ledger);
  if (changed) next.updated = now;
  return { ledger: next, ignored, changed };
}
