import { applyCommands, decodeLedger, emptyLedger, encodeLedger, LEDGER_TITLE, type Reply } from './ledger.js';
import type { Config } from './config.js';
import type { Ledger, RequestEntry } from './types.js';
const reads = new Set(['auth.test', 'pins.list', 'reactions.get', 'conversations.history', 'conversations.replies']);
export type SlackMessage = { ts: string; user?: string; text?: string; thread_ts?: string; reply_count?: number; reactions?: { name: string; users: string[]; count: number }[] };
export type LedgerRead = { ledger: Ledger; ts: string | null; paused: boolean; busy: boolean; ignored: number };
export class Slack {
  constructor(readonly token: string, readonly bot: string, readonly log: RequestEntry[], readonly dryRun = false, readonly readToken?: string) {}
  async call<T = any>(method: string, args: Record<string, unknown> = {}, token?: string): Promise<T> {
    const write = !reads.has(method);
    if (write && this.dryRun) throw new Error(`Dry run blocked Slack write: ${method}`);
    const useToken = token ?? (method === 'conversations.replies' ? this.readToken ?? this.token : this.token);
    this.log.push({ app: 'slack', method: write ? 'POST' : 'GET', path: method, at: new Date().toISOString(), write });
    const url = new URL(`https://slack.com/api/${method}`);
    if (!write) for (const [key, value] of Object.entries(args)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, { method: write ? 'POST' : 'GET', headers: { authorization: `Bearer ${useToken}`, 'content-type': 'application/json; charset=utf-8' }, ...(write ? { body: JSON.stringify(args) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Slack ${method}: HTTP ${response.status}`);
    const data = await response.json() as any;
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
    return data as T;
  }
  async messages(method: 'conversations.history' | 'conversations.replies', args: Record<string, unknown>, maximum = Infinity): Promise<SlackMessage[]> {
    const result: SlackMessage[] = []; let cursor: string | undefined;
    do {
      const page = await this.call(method, { ...args, limit: Math.min(100, maximum - result.length), ...(cursor ? { cursor } : {}) });
      result.push(...page.messages);
      cursor = page.response_metadata?.next_cursor || undefined;
      if (!cursor && page.has_more) throw new Error(`Slack ${method}: truncated response without cursor`);
    } while (cursor && result.length < maximum);
    return result.slice(0, maximum);
  }
  async inspect(config: Config, now: string): Promise<LedgerRead> {
    const channel = config.slack.channel;
    const pins = await this.call('pins.list', { channel });
    const ledgers = pins.items.map((x: any) => x.message as SlackMessage | undefined).filter((x: SlackMessage | undefined) => x?.user === this.bot && x.text?.startsWith(LEDGER_TITLE));
    if (ledgers.length > 1) throw new Error('Multiple pinned Tsuzuki ledgers; refusing ambiguous suppressions');
    const message = ledgers[0] as SlackMessage | undefined;
    let ledger = message ? decodeLedger(message.text!) : emptyLedger(now);
    if (message) {
      const reactions = await this.call('reactions.get', { channel, timestamp: message.ts, full: true });
      const paused = (reactions.message?.reactions ?? []).some((x: any) => x.name === 'no_entry_sign' && x.count > 0);
      ledger.paused = paused;
      if (paused) return { ledger, ts: message.ts, paused: true, busy: false, ignored: 0 };
    }
    const busy = ledger.lock !== null && Date.parse(now) - Date.parse(ledger.lock.at) < 900_000;
    return { ledger, ts: message?.ts ?? null, paused: false, busy, ignored: 0 };
  }
  async commands(read: LedgerRead, config: Config, now: string): Promise<LedgerRead> {
    const channel = config.slack.channel; const replies: Reply[] = [];
    if (read.ts) replies.push(...(await this.messages('conversations.replies', { channel, ts: read.ts })).filter(x => x.ts !== read.ts));
    const digests: SlackMessage[] = []; let cursor: string | undefined;
    do {
      const page = await this.call('conversations.history', { channel, limit: 100, ...(cursor ? { cursor } : {}) });
      digests.push(...page.messages.filter((x: SlackMessage) => x.user === this.bot && /^Tsuzuki, [\w.-]+\/[\w.-]+, run /.test(x.text ?? '')));
      cursor = page.response_metadata?.next_cursor || undefined;
      if (!cursor && page.has_more) throw new Error('Slack history truncated without cursor');
    } while (cursor && digests.length < config.slack.history_depth);
    for (const digest of digests.slice(0, config.slack.history_depth)) {
      const repo = /^Tsuzuki, ([\w.-]+\/[\w.-]+), run /.exec(digest.text!)![1]!;
      const thread = await this.messages('conversations.replies', { channel, ts: digest.ts });
      replies.push(...thread.filter(x => x.ts !== digest.ts).map(x => ({ ...x, repo })));
    }
    const merged = applyCommands(read.ledger, replies, config.slack.maintainers, this.bot, now);
    return { ...read, ledger: merged.ledger, ignored: merged.ignored };
  }
  async acquire(read: LedgerRead, config: Config, holder: string, now: string): Promise<LedgerRead> {
    if (read.paused || read.busy) throw new Error('Cannot lock a paused or busy ledger');
    if (this.dryRun) return read;
    const fresh = await this.inspect(config, new Date().toISOString());
    if (fresh.paused || fresh.busy || fresh.ts !== read.ts || (read.ts !== null && JSON.stringify(fresh.ledger) !== JSON.stringify(read.ledger))) throw new Error('Suppression ledger changed while snapshots were read; rerun required');
    let ts = read.ts;
    if (!ts) {
      const message = await this.call('chat.postMessage', { channel: config.slack.channel, text: encodeLedger(read.ledger), mrkdwn: true });
      ts = message.ts;
      await this.call('pins.add', { channel: config.slack.channel, timestamp: ts });
    }
    const ledger = { ...read.ledger, lock: { holder, at: now }, updated: now };
    await this.save(config.slack.channel, ts!, ledger);
    // Slack provides no compare-and-swap; also serialize invocations in the scheduler.
    const pins = await this.call('pins.list', { channel: config.slack.channel });
    const stored = pins.items.find((x: any) => x.message?.ts === ts)?.message;
    if (!stored || decodeLedger(stored.text).lock?.holder !== holder) throw new Error('Lost Slack run lock');
    return { ...read, ts: ts!, ledger };
  }
  async save(channel: string, ts: string, ledger: Ledger): Promise<void> {
    await this.call('chat.update', { channel, ts, text: encodeLedger(ledger) });
  }
  async release(read: LedgerRead, config: Config, holder: string): Promise<void> {
    if (this.dryRun || !read.ts) return;
    const pins = await this.call('pins.list', { channel: config.slack.channel });
    const message = pins.items.find((x: any) => x.message?.ts === read.ts)?.message;
    if (!message) throw new Error('Ledger disappeared while releasing run lock');
    const ledger = decodeLedger(message.text);
    if (ledger.lock?.holder !== holder) throw new Error('Run lock owner changed');
    await this.save(config.slack.channel, read.ts, { ...ledger, lock: null, updated: new Date().toISOString() });
  }
  async post(channel: string, text: string): Promise<void> {
    await this.call('chat.postMessage', { channel, text, mrkdwn: false, unfurl_links: false, unfurl_media: false });
  }
}
