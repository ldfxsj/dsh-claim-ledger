const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function displayWidth(s) {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

export function pad(s, width) {
  const text = String(s);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function clip(s, width) {
  const text = String(s);
  if (displayWidth(text) <= width) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

const MARK = { verified: '✓', refuted: '✗', unverifiable: '?' };
const STANCE = { action: '行动', report: '陈述' };

export function renderTable({ claims, summary }, { width = 110 } = {}) {
  const lines = [];
  const marks = claims.map((c) => `${MARK[c.verdict] ?? '?'} ${c.verdict}${c.grade && c.grade !== 'none' ? `·${c.grade}` : ''}`);
  const vw = Math.max(displayWidth('判定'), ...marks.map(displayWidth)) + 2;
  const quoteWidth = Math.max(24, Math.min(58, width - vw - 38));

  lines.push(
    `${pad('#', 3)}${pad('t', 4)}${pad('姿态', 5)}${pad('判定', vw)}${pad('断言', quoteWidth + 2)}证据`,
  );
  lines.push('─'.repeat(width));

  claims.forEach((c, i) => {
    const ev = c.evidence
      .map((e) =>
        e.grade === 'log'
          ? `${e.tool}→${e.token}`
          : e.error
            ? `核验失败:${e.error}`
            : `live:${e.detail}`,
      )
      .join(' | ');
    lines.push(
      `${pad(i + 1, 3)}${pad(c.turn, 4)}${pad(STANCE[c.stance] ?? '?', 5)}${pad(marks[i], vw)}${pad(clip(c.quote, quoteWidth), quoteWidth + 2)}${clip(ev, Math.max(20, width - quoteWidth - vw - 11))}`,
    );
  });

  lines.push('─'.repeat(width));
  lines.push(
    `claims ${summary.total} · ✓ verified ${summary.verified} · ✗ refuted ${summary.refuted} · ? unverifiable ${summary.unverifiable}` +
      (summary.liveChecks ? ` · live 核验 ${summary.liveChecks}` : ''),
  );
  const action = summary.byStance?.action;
  if (action) {
    lines.push(`其中行动类 ${action.total} 条：✓${action.verified} ✗${action.refuted} ?${action.unverifiable}`);
  }
  const cov = summary.coverage;
  if (cov && cov.completions > 0) {
    const pct = Math.round((cov.backed / cov.completions) * 100);
    lines.push(
      `完成性断言 ${cov.completions} 句 · 有 token 可查 ${cov.backed} 句（${pct}%）· 没有 token ${cov.unbacked} 句（不进表，未取证）`,
    );
    for (const ex of cov.examples.slice(0, 3)) {
      lines.push(`  · t${ex.turn} ${clip(ex.quote, width - 6)}`);
    }
  }

  return lines.join('\n');
}

export function renderBadge(summary) {
  const base = `assertions ${summary.total} · ✓${summary.verified} ✗${summary.refuted} ?${summary.unverifiable}`;
  const action = summary.byStance?.action;
  const cov = summary.coverage;
  const tail = cov && cov.completions > 0 ? ` · 覆盖 ${Math.round((cov.backed / cov.completions) * 100)}%` : '';
  return (action
    ? `${base} · 行动 ${action.total}（✓${action.verified} ✗${action.refuted} ?${action.unverifiable}）`
    : base) + tail;
}

/** 自动记账的快照：每个回合一行计数，被推翻的断言逐条列出来。 */
export function renderRecorded(snapshot, { width = 110 } = {}) {
  if (!snapshot) return null;
  const s = snapshot.summary;
  const lines = [];

  lines.push(`记账 ${snapshot.recordedAt} · turn ${snapshot.turn ?? '?'} · session ${snapshot.sessionId}`);
  if (snapshot.file) lines.push(`log ${snapshot.file}`);
  lines.push('');

  if (!snapshot.turns?.length) {
    lines.push('（这个会话还没有带内容的回合）');
  } else {
    const withActions = snapshot.turns.some((t) => typeof t.actions === 'number');
    lines.push(
      `${pad('t', 5)}${pad('断言', 6)}${withActions ? pad('行动', 6) : ''}${pad('✓', 5)}${pad('✗', 5)}${pad('?', 5)}状态`,
    );
    lines.push('─'.repeat(Math.min(48, width)));
    for (const turn of snapshot.turns) {
      lines.push(
        `${pad(turn.turn, 5)}${pad(turn.claims, 6)}${withActions ? pad(turn.actions ?? 0, 6) : ''}${pad(turn.verified, 5)}${pad(turn.refuted, 5)}${pad(turn.unverifiable, 5)}${
          turn.ended ? '已结束' : '进行中'
        }`,
      );
    }
    lines.push('─'.repeat(Math.min(48, width)));
  }

  const refuted = (snapshot.claims ?? []).filter((c) => c.verdict === 'refuted');
  if (refuted.length) {
    lines.push('');
    lines.push('被推翻：');
    for (const claim of refuted) {
      lines.push(`  ✗ t${claim.turn} ${clip(claim.quote, Math.max(30, width - 10))}`);
      if (claim.note) lines.push(`      ${clip(claim.note, Math.max(30, width - 6))}`);
    }
  }

  lines.push('');
  lines.push(`claims ${s.total} · ✓${s.verified} ✗${s.refuted} ?${s.unverifiable}（自动记账只跑本机文件核验）`);
  const action = s.byStance?.action;
  if (action) lines.push(`其中「我做了什么」${action.total} 条：✓${action.verified} ✗${action.refuted} ?${action.unverifiable}`);
  const cov = s.coverage;
  if (cov && cov.completions > 0) {
    lines.push(
      `完成性断言 ${cov.completions} 句 · 可核验 ${cov.backed} 句（${Math.round((cov.backed / cov.completions) * 100)}%）· 没有 token ${cov.unbacked} 句`,
    );
  }
  lines.push('没有可执行核验的 ? 不等于通过；纯链接、无动作词的句子不判定。');
  return lines.join('\n');
}

const KIND = { version: '版本号', path: '路径', number: '数字', run: '跑通' };

/** 跨会话走势：一眼看「从第几个回合开始不确定」和「哪类断言从没被核实过」。 */
/**
 * 未取证清单：徽章只给一个百分比，看的人需要能逐条看到「到底哪句没把手」。
 * 这些句子没有事实 token，所以它们从来不会进台账——不是被放过了，是压根测不到。
 */
export function renderUnbacked({ summary }, { width = 110 } = {}) {
  const c = summary?.coverage ?? { completions: 0, backed: 0, unbacked: 0, examples: [], unbackedList: [] };
  const list = c.unbackedList ?? c.examples ?? [];
  const total = c.unbacked ?? list.length;
  const out = [];

  out.push(`未取证清单 · 完成性断言 ${c.completions} 句 · 可查 ${c.backed} 句 · 没有 token ${total} 句`);
  out.push('');
  if (!list.length) {
    out.push('没有未取证的完成性断言。');
    return out.join('\n');
  }
  for (const item of list.slice(0, 60)) {
    out.push(`t${item.turn}  ${clip(item.quote, width - 8)}`);
  }
  if (list.length < total) out.push(`…还有 ${total - list.length} 句（清单最多记 200 条）`);
  out.push('');
  out.push('这些句子只有完成动词、没有事实 token，所以不判定——不是通过，是测不到。');
  return out.join('\n');
}

export function renderErrors({ file, lines, ledgerDir }, { width = 110 } = {}) {
  const out = [`记账自身的错误 · ${ledgerDir}`];
  if (!lines.length) {
    out.push('');
    out.push('没有错误记录。');
    out.push('记账失败不会打断会话，所以它只写这里；这里为空说明自动记账没崩过。');
    return out.join('\n');
  }
  out.push('');
  for (const line of lines) out.push(clip(line, width));
  out.push('');
  out.push(`共 ${lines.length} 行 · ${file}`);
  return out.join('\n');
}

export function renderTrends(report, { width = 110 } = {}) {
  const { journal, claims } = report;
  const totals = journal.totals;
  const lines = [];

  lines.push(`走势 ${report.dir}`);
  if (!journal.sessions.length) {
    lines.push('');
    lines.push('还没有 journal.jsonl：等第一个回合结束后再跑一次。');
    return lines.join('\n');
  }

  lines.push(
    `跨会话 ${totals.sessions} 个 · ${totals.turns} 回合 · ${totals.claims} 条断言（✓${totals.verified} ✗${totals.refuted} ?${totals.unverifiable}）`,
  );
  if (journal.skipped) lines.push(`（journal 有 ${journal.skipped} 行无法解析，已跳过）`);
  lines.push('');

  lines.push(`${pad('会话', 14)}${pad('回合', 6)}${pad('断言', 6)}${pad('✓', 4)}${pad('✗', 4)}${pad('?', 4)}首个?`);
  lines.push('─'.repeat(Math.min(46, width)));
  for (const session of journal.sessions.slice(0, 12)) {
    const label = session.sessionId.replace(/^session-/, '').slice(0, 8);
    lines.push(
      `${pad(label, 14)}${pad(session.turns, 6)}${pad(session.claims, 6)}${pad(session.verified, 4)}${pad(
        session.refuted,
        4,
      )}${pad(session.unverifiable, 4)}${session.firstUnknownTurn === null ? '—' : `t${session.firstUnknownTurn}`}`,
    );
  }
  if (journal.sessions.length > 12) lines.push(`…另有 ${journal.sessions.length - 12} 个会话`);
  lines.push('─'.repeat(Math.min(46, width)));
  const snapshotRefuted = claims.rows.reduce((n, row) => n + row.refuted, 0);
  lines.push(
    `有 ? 的会话 ${totals.sessionsWithUnknown}/${totals.sessions}${totals.refuted ? ` · journal 记被推翻 ${totals.refuted} 条` : ''}${
      snapshotRefuted ? ` · 最新快照里被推翻 ${snapshotRefuted} 条` : ''
    }`,
  );

  if (claims.rows.length) {
    lines.push('');
    lines.push(`断言类型（来自 ${report.snapshots} 个快照）`);
    lines.push(`${pad('类型', 18)}${pad('总数', 6)}${pad('✓', 5)}${pad('✗', 5)}${pad('?', 5)}`);
    lines.push('─'.repeat(Math.min(46, width)));
    for (const row of claims.rows) {
      const [stance, kind] = row.key.split('/');
      lines.push(
        `${pad(`${STANCE[stance] ?? stance}·${KIND[kind] ?? kind}`, 18)}${pad(row.total, 6)}${pad(row.verified, 5)}${pad(
          row.refuted,
          5,
        )}${pad(row.unverifiable, 5)}`,
      );
    }
    lines.push('─'.repeat(Math.min(46, width)));
  }

  if (claims.never.length) {
    lines.push('');
    lines.push('从没被核实过的类型（✓0）：');
    for (const row of claims.never) {
      const [stance, kind] = row.key.split('/');
      lines.push(`  ${STANCE[stance] ?? stance}·${KIND[kind] ?? kind}  ${row.total} 条：✗${row.refuted} ?${row.unverifiable}`);
      for (const quote of claims.examples.get(row.key) ?? []) {
        lines.push(`      ${clip(quote, Math.max(30, width - 8))}`);
      }
    }
  }

  lines.push('');
  lines.push('「首个?」是这个会话里第一次出现无法核验断言的回合；? 从早期就开始，通常说明取证没跟上，而不是谎报。');
  return lines.join('\n');
}
