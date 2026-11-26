import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerDir, readSnapshot } from './store.mjs';

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** journal.jsonl 是每回合追加的一行；坏行不阻塞，但要数出来——台账自己不能静默。 */
export function readJournal({ dir = ledgerDir() } = {}) {
  const file = join(dir, 'journal.jsonl');
  if (!existsSync(file)) return { entries: [], skipped: 0, file };
  const entries = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const entry = JSON.parse(text);
      if (entry && typeof entry === 'object') entries.push(entry);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped, file };
}

/** 每个会话一条线：从第几回合开始出现 `?`，是这个走势里唯一真正有信息量的点。 */
export function summarizeJournal(entries) {
  const bySession = new Map();

  for (const entry of entries) {
    const sessionId = String(entry.sessionId ?? '?');
    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, {
        sessionId,
        turns: 0,
        claims: 0,
        verified: 0,
        refuted: 0,
        unverifiable: 0,
        firstTurn: null,
        lastTurn: null,
        firstUnknownTurn: null,
      });
    }
    const row = bySession.get(sessionId);
    row.turns += 1;
    row.claims += num(entry.claims);
    row.verified += num(entry.verified);
    row.refuted += num(entry.refuted);
    row.unverifiable += num(entry.unverifiable);

    if (typeof entry.turn === 'number' && Number.isFinite(entry.turn)) {
      row.firstTurn = row.firstTurn === null ? entry.turn : Math.min(row.firstTurn, entry.turn);
      row.lastTurn = row.lastTurn === null ? entry.turn : Math.max(row.lastTurn, entry.turn);
      if (row.firstUnknownTurn === null && num(entry.unverifiable) > 0) row.firstUnknownTurn = entry.turn;
    }
  }

  const sessions = [...bySession.values()].sort((a, b) => (b.lastTurn ?? -1) - (a.lastTurn ?? -1));
  const totals = sessions.reduce(
    (acc, s) => ({
      sessions: acc.sessions + 1,
      turns: acc.turns + s.turns,
      claims: acc.claims + s.claims,
      verified: acc.verified + s.verified,
      refuted: acc.refuted + s.refuted,
      unverifiable: acc.unverifiable + s.unverifiable,
      sessionsWithUnknown: acc.sessionsWithUnknown + (s.firstUnknownTurn !== null ? 1 : 0),
    }),
    { sessions: 0, turns: 0, claims: 0, verified: 0, refuted: 0, unverifiable: 0, sessionsWithUnknown: 0 },
  );

  return { sessions, totals };
}

const VERSION = /^\d+\.\d+\.\d+/;
const PATH = /^[A-Za-z]:\\/;

/** 把一条断言归到「立场 × token 类型」——用来回答「哪类话从没被核实过」。 */
export function kindOfClaim(claim) {
  const token = (claim.tokens ?? [])[0] ?? '';
  if (VERSION.test(token)) return 'version';
  if (PATH.test(token)) return 'path';
  return 'number';
}

export function claimStats(snapshots) {
  const buckets = new Map();
  const examples = new Map();

  for (const snapshot of snapshots) {
    for (const claim of snapshot?.claims ?? []) {
      const key = `${claim.stance === 'action' ? 'action' : 'report'}/${kindOfClaim(claim)}`;
      if (!buckets.has(key)) buckets.set(key, { key, total: 0, verified: 0, refuted: 0, unverifiable: 0 });
      const bucket = buckets.get(key);
      bucket.total += 1;
      if (claim.verdict === 'verified') bucket.verified += 1;
      else if (claim.verdict === 'refuted') bucket.refuted += 1;
      else bucket.unverifiable += 1;

      if (claim.verdict !== 'verified') {
        if (!examples.has(key)) examples.set(key, []);
        const list = examples.get(key);
        if (list.length < 2 && !list.some((q) => q === claim.quote)) list.push(claim.quote);
      }
    }
  }

  const rows = [...buckets.values()].sort((a, b) => b.total - a.total);
  return { rows, examples, never: rows.filter((r) => r.verified === 0) };
}

/** 读目录下所有快照；坏文件跳过（快照写的时候是原子的，坏的大概率是手动改坏的）。 */
export function readSnapshots({ dir = ledgerDir() } = {}) {
  if (!existsSync(dir)) return { snapshots: [], skipped: 0 };
  const snapshots = [];
  let skipped = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const snapshot = readSnapshot(name.slice(0, -'.json'.length), { dir });
    if (snapshot && Array.isArray(snapshot.claims)) snapshots.push(snapshot);
    else skipped += 1;
  }
  return { snapshots, skipped };
}

export function trends({ dir = ledgerDir() } = {}) {
  const journal = readJournal({ dir });
  const sessions = summarizeJournal(journal.entries);
  const { snapshots, skipped } = readSnapshots({ dir });
  return {
    dir,
    journal: { ...sessions, skipped: journal.skipped },
    claims: claimStats(snapshots),
    snapshots: snapshots.length,
    snapshotsSkipped: skipped,
  };
}
