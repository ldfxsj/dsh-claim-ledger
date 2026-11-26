import { audit } from './ledger.mjs';
import { createLive } from './live.mjs';
import { appendJournal, noteError, pruneLedger, saveSnapshot } from './store.mjs';

const KEEP = ['id', 'turn', 'step', 'quote', 'tokens', 'verdict', 'grade', 'note', 'stance'];

function trimClaim(claim) {
  const out = {};
  for (const key of KEEP) out[key] = claim[key];
  return out;
}

function perTurn(turns, claims) {
  // 一次分组，别对每个回合都把全部断言过滤一遍（长会话上是 O(回合 × 断言)）
  const byTurn = new Map();
  for (const claim of claims) {
    let list = byTurn.get(claim.turn);
    if (!list) byTurn.set(claim.turn, (list = []));
    list.push(claim);
  }
  return turns.map((turn) => {
    const mine = byTurn.get(turn.turn) ?? [];
    const actions = mine.filter((c) => c.stance === 'action');
    return {
      turn: turn.turn,
      ended: turn.ended === true,
      claims: mine.length,
      verified: mine.filter((c) => c.verdict === 'verified').length,
      refuted: mine.filter((c) => c.verdict === 'refuted').length,
      unverifiable: mine.filter((c) => c.verdict === 'unverifiable').length,
      actions: actions.length,
    };
  });
}

/**
 * 一个回合的台账快照。核验只跑本机文件那一档：自动记账发生在每个 turn/end，
 * 不能在这里发网络请求或起进程，否则「挂旁边」的东西会变成每回合的负载。
 */
export function buildSnapshotFromResult({
  sessionId,
  file = null,
  turns,
  result,
  turn = null,
  recordedAt = new Date().toISOString(),
}) {
  const claims = result.claims.map(trimClaim);
  return {
    version: 1,
    sessionId,
    file,
    turn,
    recordedAt,
    summary: result.summary,
    turns: perTurn(turns, claims),
    claims,
  };
}

/** 一次性构建（测试与命令行用）：从头审计，等价于增量喂入同一批回合。 */
export function buildSnapshot({ sessionId, file = null, turns, turn = null, recordedAt = new Date().toISOString() }) {
  const result = audit({ turns, live: 'local' });
  return buildSnapshotFromResult({ sessionId, file, turns, result, turn, recordedAt });
}

export function describeSnapshot(snapshot) {
  const s = snapshot.summary;
  return `t${snapshot.turn ?? '?'} · claims ${s.total} · ✓${s.verified} ✗${s.refuted} ?${s.unverifiable}`;
}

/**
 * 回合结束就把台账写下来。这里做的事情不超过「算一次 + 落两个文件」，
 * 任何异常都只写 errors.log —— 它在 session/event 的 emit 里跑，抛出去会伤到会话本身。
 */
export function createRecorder({
  dir,
  debounceMs = 250,
  build = null,
  now = () => new Date(),
  live = 'local',
  pruneEvery = 20,
  store = null,
} = {}) {
  const timers = new Map();
  /** sessionId → file：台账算在 store 里，这里只记每个会话的日志路径。 */
  const files = new Map();
  const ownStore = store === null;
  // 没有外部 store 时自己建一个：测试与命令行仍能按老方式用。
  const liveStore = store ?? createLive({ live });
  let records = 0;
  let disposed = false;

  const make = build ?? ((job) => (job.result ? buildSnapshotFromResult(job) : buildSnapshot(job)));

  function record(job) {
    const recordedAt = now().toISOString();
    if (job.file) files.set(job.sessionId, job.file);
    liveStore.ingestTurns(job.sessionId, job.turns ?? []);
    const snapshot = make({
      ...job,
      file: job.file ?? files.get(job.sessionId) ?? null,
      recordedAt,
      result: liveStore.resultOf(job.sessionId),
    });
    saveSnapshot(job.sessionId, snapshot, { dir });
    appendJournal(
      {
        at: recordedAt,
        sessionId: job.sessionId,
        turn: job.turn ?? null,
        claims: snapshot.summary.total,
        verified: snapshot.summary.verified,
        refuted: snapshot.summary.refuted,
        unverifiable: snapshot.summary.unverifiable,
      },
      { dir },
    );
    records += 1;
    if (pruneEvery > 0 && records % pruneEvery === 0) {
      try {
        pruneLedger({ dir });
      } catch (error) {
        noteError(`台账清理失败：${error?.message ?? error}`, { dir, now });
      }
    }
    return snapshot;
  }

  return {
    /** job: { sessionId, file, turns, turn } —— 同一会话连着的多次调度只跑最后一次。 */
    schedule(job) {
      if (disposed || !job?.sessionId) return;
      const pending = timers.get(job.sessionId);
      if (pending) clearTimeout(pending);
      const timer = setTimeout(() => {
        timers.delete(job.sessionId);
        try {
          record(job);
        } catch (error) {
          noteError(`记账失败 session=${job.sessionId} turn=${job.turn ?? '?'}: ${error?.message ?? error}`, { dir, now });
        }
      }, debounceMs);
      timer.unref?.();
      timers.set(job.sessionId, timer);
    },
    /** 测试用：立刻跑一次，不等抖动窗口。 */
    recordNow(job) {
      try {
        return record(job);
      } catch (error) {
        noteError(`记账失败 session=${job.sessionId} turn=${job.turn ?? '?'}: ${error?.message ?? error}`, { dir, now });
        return null;
      }
    },
    pending() {
      return timers.size;
    },
    /** 会话结束时丢掉它的内存台账：增量状态不能无限留着。 */
    forget(sessionId) {
      if (!sessionId) return;
      files.delete(sessionId);
      // 共享 store 时不能在这里清：投影还在读同一个会话的台账
      if (ownStore) liveStore.forget(sessionId);
      const timer = timers.get(sessionId);
      if (timer) clearTimeout(timer);
      timers.delete(sessionId);
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      files.clear();
      if (ownStore) liveStore.dispose();
    },
  };
}
