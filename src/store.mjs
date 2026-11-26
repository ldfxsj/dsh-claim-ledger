import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './resolve.mjs';

/** 台账落盘目录：`~/.dsh/claim-ledger/`（可用 DSH_HOME 覆盖）。 */
export function ledgerDir(home = dshHome()) {
  return join(home, 'claim-ledger');
}

function safeId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function snapshotPath(sessionId, dir = ledgerDir()) {
  return join(dir, `${safeId(sessionId)}.json`);
}

/** 先写临时文件再改名：写到一半被打断也不会留下半个 JSON。 */
export function saveSnapshot(sessionId, snapshot, { dir = ledgerDir() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = snapshotPath(sessionId, dir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

export function readSnapshot(sessionId, { dir = ledgerDir() } = {}) {
  const file = snapshotPath(sessionId, dir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 每回合一行，便于 grep 一段时间的走势；坏了也不影响快照。 */
export function appendJournal(entry, { dir = ledgerDir() } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 历史行丢了不算故障，快照才是主产物
  }
}

/**
 * 记账失败必须留下痕迹。这个插件的全部意义就是「不静默」，
 * 所以错误写进独立文件，而不是被 try/catch 吞掉。
 */
export function noteError(message, { dir = ledgerDir(), now = () => new Date() } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'errors.log'), `[${now().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // 连错误都写不下去（目录不可写）：这时唯一安全的动作是保持安静，
    // 因为抛进 session/event 会打断会话本身。
  }
}

/** errors.log 的尾巴：之前只写没人读，等于又一个静默。 */
export function readErrors({ dir = ledgerDir(), limit = 20 } = {}) {
  const file = join(dir, 'errors.log');
  if (!existsSync(file)) return { file, lines: [] };
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-Math.max(1, limit));
  return { file, lines };
}

/**
 * 台账清理。快照是「每个会话一个文件、每回合覆盖」，但会话多了会攒到成千上万个；
 * journal 是追加写的，一年下来能到几十 MB。这里只保留最近 N 个快照 + 修掉过大的日志。
 * 只在记账时偶尔跑一次（见 auto.mjs 的 PRUNE_EVERY），不在热路径每次都扫目录。
 */
export function pruneLedger({
  dir = ledgerDir(),
  keepSnapshots = 200,
  maxAgeDays = 30,
  journalMaxBytes = 4 * 1024 * 1024,
  errorsMaxBytes = 256 * 1024,
  now = () => Date.now(),
} = {}) {
  const result = { snapshots: 0, journals: 0, errors: 0 };
  if (!existsSync(dir)) return result;

  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }

  const snapshots = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const full = join(dir, name);
      const st = statSync(full);
      snapshots.push({ full, mtime: st.mtimeMs });
    } catch {
      // 这一条读不到就跳过
    }
  }
  snapshots.sort((a, b) => b.mtime - a.mtime);
  const cutoff = now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const [i, snap] of snapshots.entries()) {
    if (i < keepSnapshots && snap.mtime >= cutoff) continue;
    try {
      unlinkSync(snap.full);
      result.snapshots += 1;
    } catch {
      // 删不掉就留着，下一次再试
    }
  }

  for (const [name, cap] of [
    ['journal.jsonl', journalMaxBytes],
    ['errors.log', errorsMaxBytes],
  ]) {
    const full = join(dir, name);
    try {
      if (!existsSync(full)) continue;
      const st = statSync(full);
      if (st.size <= cap) continue;
      const text = readFileSync(full, 'utf8');
      // 只留尾巴：journal 是走势用的，errors 只需要最近这些
      const kept = text.slice(Math.floor(text.length / 2));
      writeFileSync(full, kept.slice(kept.indexOf('\n') + 1), 'utf8');
      if (name === 'journal.jsonl') result.journals += 1;
      else result.errors += 1;
    } catch {
      // 同上：清理失败不影响主流程
    }
  }

  return result;
}
