import { doneSentences, extractClaims, tokensOf } from './extract.mjs';
import { describeCheck, runCheck } from './checks.mjs';

export const VERIFIED = 'verified';
export const REFUTED = 'refuted';
export const UNVERIFIABLE = 'unverifiable';

const normNumber = (v) => v.replace(/[,，\s]/g, '');

/**
 * 证据池的倒排索引：池子会随着回合一直变长，而每条断言都要问「这些事实出现过吗」。
 * 线性扫描是 O(池子 × token)，长会话上单回合就能吃掉 250 ms。这里在入池时把
 * 每条工具输出里的事实 token 抽出来建一次 Map，之后查一次是 O(1)。
 * 只索引 `text`（回显）；入参条目（kind: 'call'）没有回显，走写文件专用通道。
 */
function indexEvidence(state, entry) {
  if (typeof entry.text === 'string') {
    for (const t of tokensOf(entry.text)) {
      const key = t.kind === 'number' ? normNumber(t.value) : t.value;
      if (!state.tokenIndex.has(key)) state.tokenIndex.set(key, entry);
    }
  }
  if (entry.callId && !state.callIndex.has(entry.callId)) state.callIndex.set(entry.callId, entry);
}

function findTokenIndexed(state, token) {
  const key = token.kind === 'number' ? normNumber(token.value) : token.value;
  return state.tokenIndex.get(key) ?? null;
}

/**
 * `checks` 文件支持两种形状：
 *   1. 对象：{ "断言原文": { 核验 } }（精确匹配，老写法）
 *   2. { rules: [ { pattern, flags?, check } ] } 或直接数组：按正则顺序匹配
 * 正则让「同一类说法」只写一条规则，而不用把每句原话都抄一遍。
 */
export function curatedFor(quote, checks) {
  if (!checks || typeof quote !== 'string') return null;
  if (!Array.isArray(checks) && typeof checks[quote] === 'object') return checks[quote];
  const rules = Array.isArray(checks) ? checks : Array.isArray(checks.rules) ? checks.rules : [];
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== 'string') continue;
    let re;
    try {
      re = new RegExp(rule.pattern, rule.flags ?? '');
    } catch {
      continue; // 写错的正则应该被跳过，而不是让整次审计崩掉
    }
    if (re.test(quote)) return rule.check ?? null;
  }
  return null;
}

/** 自动核验只覆盖不会误判的形状。其余靠 checks 文件，或留在“待定”。 */
const ABSENT_HINT = /已(删除|清理|移除)|删掉了|已清理/;
const EXISTS_HINT = /已(创建|写入|落盘|保存)|写好了/;
// “成品在 X”“备份在 X”“另存了一份在 X”——存在性断言。用词表保守，宁可漏判。
const EXISTS_WORD = /成品|产物|备份|保留在|另存|保存在|写到了|落在/;

// “我装不了 / 跑不通 / 失败了”——否认类断言。token 出现在输出里只能证明那个名词存在，
// 证明不了「做不到」，所以这种句子不能靠日志证据升级。
// 只认第一人称/无主语的不可能式；「失败后逼它换方法」这种把“失败”当名词的描述不算。
const NEGATIVE =
  /(?:^|[，。；、：“”"'（(\s])我[^。；，]{0,8}?(?:不了|不通|不到|不行|没法|不能|无法)|(?:装|跑|用|做|弄|改|修)不了|没法(?:装|跑|用)|(?:失败|报错|没成功)了/;
const FAILURE_HINT = /(?:error|failed|failure|denied|refused|ENOENT|EACCES|EINVAL|not found|traceback|报错|失败|拒绝)/i;

/** 只读本机文件系统的核验：便宜、无网络、无进程，可以在每个回合结束时自动跑。 */
const LOCAL_CHECKS = new Set(['path_exists', 'path_absent', 'file_contains', 'file_clean']);

export function isLocalCheck(check) {
  return Boolean(check) && LOCAL_CHECKS.has(check.type);
}

/**
 * 「我把 X 写好了 / 重写了 X」——证据在**工具调用的参数**里，不在回执里。
 * write 的回执通常只有 "Updated file"，路径只存在于 arguments。
 * 只有写入族的工具算数：读文件、跑命令的入参里出现路径，不构成「我写过它」。
 */
const WRITE_VERB = /(?:重写|改写|覆写|写入|写进|保存|更新|创建|生成|落盘|覆盖|写好|写坏|改好|补好|贴进|搬进)/;
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'write_file', 'create_file', 'str_replace']);

/** 这条断言是不是「写文件类」；是的话返回它要写的那个路径 token。 */
export function writeTargetOf(claim) {
  if (claim.stance !== 'action') return null;
  if (NEGATIVE.test(claim.quote)) return null;
  if (ABSENT_HINT.test(claim.quote)) return null;
  if (!WRITE_VERB.test(claim.quote)) return null;
  return claim.tokens.find((t) => t.kind === 'path' && !t.elided) ?? null;
}

export function writeCallsFor(pathValue, pool, claimTurn) {
  // Windows 路径不区分大小写：断言写 D:\x\A、入参是 D:\x\a 也算同一条路径。
  const needle = typeof pathValue === 'string' ? pathValue.toLowerCase() : pathValue;
  return pool.filter(
    (t) =>
      t.kind === 'call' &&
      WRITE_TOOLS.has(t.name) &&
      t.turn <= claimTurn &&
      typeof t.argsText === 'string' &&
      t.argsText.toLowerCase().includes(needle),
  );
}

function autoCheck(claim) {
  const path = claim.tokens.find((t) => t.kind === 'path' && !t.elided);
  if (!path) return null;
  if (ABSENT_HINT.test(claim.quote)) return { type: 'path_absent', path: path.value };
  if (EXISTS_HINT.test(claim.quote) || EXISTS_WORD.test(claim.quote)) {
    return { type: 'path_exists', path: path.value };
  }
  return null;
}

/** 纯链接里的路径（`[预览](D:\x.png)`）不核验——用户 2026-11-26 明确要求别把链接当断言。 */
function insideMarkdownLink(quote, value) {
  const at = quote.indexOf(value);
  if (at < 0) return false;
  const before = quote.slice(0, at);
  return before.lastIndexOf('](') > before.lastIndexOf(')');
}

/**
 * `live` 取值：
 *   - `false`（默认）：只读日志证据
 *   - `'local'`：只跑本机文件核验（path_exists / path_absent / file_contains），自动记账用这个
 *   - `true` / `'all'`：跑全部核验（含 npm registry 与只读命令）
 *
 * 判定顺序：
 *   1. 有 live 且有核验动作 → 以现场结果为准（这是唯一能推翻的方式）
 *   2. 否则看**本会话截至当前的**工具输出：全部事实 token 都在 → verified(log)
 *      （证据必须出现在断言之前或同一轮；后一轮的工具输出不能回溯证明前一轮说过的话）
 *   3. 否则 → unverifiable（不是失败，是“没有机械证据”）
 * 核验失败（crash）永不产生 refuted。
 */
/**
 * 增量台账：喂一个回合就定下这个回合的判定，绝不回头重算。
 *
 * 这与一次性全量 audit() 的语义完全一致，因为规则本身就要求「证据只能来自
 * 断言之前或同一回合」——晚到的回合不可能改变早先的判定。差别只在代价：
 * 全量审计是 O(回合²)（每个 turn/end 都把整段历史重新扫一遍），增量是 O(回合)。
 *
 * 长会话（本机有个 329 回合、481 条断言的会话）全量一次 2.4 秒，而自动记账
 * 每个 turn/end 都要跑一次，累计是分钟级，还全堵在 session/event 的同步回调里。
 */
export function createLedger({ live = false, checks = {}, stance = null } = {}) {
  const state = {
    rows: [],
    evidencePool: [],
    tokenIndex: new Map(),
    callIndex: new Map(),
    coverage: { completions: 0, backed: 0, unbacked: 0, examples: [], unbackedList: [] },
    turns: 0,
    lastTurn: null,
  };
  return {
    get turns() {
      return state.turns;
    },
    get lastTurn() {
      return state.lastTurn;
    },
    ingest(turn, { onlyTurns = null } = {}) {
      ingestTurn(state, turn, { live, checks, stance, onlyTurns });
      state.turns += 1;
      state.lastTurn = turn.turn;
    },
    result() {
      return { claims: state.rows, summary: summarize(state.rows, state.coverage) };
    },
    coverage() {
      return { ...state.coverage, examples: [...state.coverage.examples] };
    },
  };
}

export function audit({ turns, onlyTurns = null, checks = {}, live = false, stance = null }) {
  const ledger = createLedger({ live, checks, stance });
  for (const turn of turns) ledger.ingest(turn, { onlyTurns });
  return ledger.result();
}

function ingestTurn(state, turn, { live = false, checks = {}, stance = null, onlyTurns = null } = {}) {
  const { rows, evidencePool, coverage } = state;

  // 先把本轮工具输出并入证据池，再判定本轮断言：同轮证据有效
  for (const tool of turn.tools) {
    const entry = { ...tool, turn: turn.turn };
    evidencePool.push(entry);
    indexEvidence(state, entry);
  }
  // 入参是第二证据通道：写文件类断言的路径只在这里出现
  for (const call of turn.calls ?? []) {
    const entry = { ...call, kind: 'call', turn: turn.turn };
    evidencePool.push(entry);
    indexEvidence(state, entry);
  }

    if (onlyTurns && !onlyTurns.includes(turn.turn)) return;

    // 覆盖率：只统计「完成性断言」，不含条件句；有 token 的才可能进台账
    for (const rec of turn.assistant) {
      for (const block of rec.data?.message?.content ?? []) {
        if (block.type !== 'text') continue;
        for (const sentence of doneSentences(block.text)) {
          coverage.completions += 1;
          if (tokensOf(sentence).some((t) => !t.elided)) {
            coverage.backed += 1;
          } else {
            coverage.unbacked += 1;
            if (coverage.examples.length < 5) coverage.examples.push({ turn: turn.turn, quote: sentence });
            // 完整清单（上限 200）：徽章只给比例，问题清单要能逐条看
            if (coverage.unbackedList.length < 200) coverage.unbackedList.push({ turn: turn.turn, quote: sentence });
          }
        }
      }
    }

    for (const claim of extractClaims(turn)) {
      if (stance && claim.stance !== stance) continue;
      const evidence = [];
      // 省略号截断的 token（`D:\…docx`）不是事实，不该要求它出现在输出里，更不该拿去探路径。
      const required = claim.tokens.filter((t) => !t.elided);
      let groundedCount = 0;

      for (const token of required) {
        const hit = findTokenIndexed(state, token);
        if (hit) {
          groundedCount += 1;
          evidence.push({ grade: 'log', tool: hit.name, callId: hit.callId, evidenceTurn: hit.turn, token: token.value });
        }
      }

      const allGrounded = required.length > 0 && groundedCount === required.length;
      let verdict = allGrounded ? VERIFIED : UNVERIFIABLE;
      let grade = allGrounded ? 'log' : 'none';
      const earliest = evidence.reduce((m, e) => (e.evidenceTurn != null ? Math.min(m, e.evidenceTurn) : m), claim.turn);
      let note = allGrounded
        ? `工具输出包含全部 ${required.length} 个事实（证据来自 turn ${earliest}）`
        : required.length === 0
          ? '事实 token 被省略号截断（…），无从核验'
          : '本会话工具输出里找不到该事实，没有可执行的核验';

      // 否认类（“我装不了”“跑不通”）是坑：token 出现过 ≠ 做不到。
      // 不论立场都降级——一句转述「我装不了」的话同样不能用路径存在来支持。
      if (verdict === VERIFIED && NEGATIVE.test(claim.quote)) {
        const sawFailure = evidence.some((e) => {
          if (e.grade !== 'log') return false;
          const tool = state.callIndex.get(e.callId) ?? evidencePool.find((t) => t.callId === e.callId);
          return Boolean(tool && typeof tool.text === 'string' && FAILURE_HINT.test(tool.text));
        });
        if (!sawFailure) {
          verdict = UNVERIFIABLE;
          grade = 'none';
          note = '否认 / 失败类断言不能靠 token 出现在输出里支持——要么有报错输出，要么现场核验';
        }
      }

      const curated = curatedFor(claim.quote, checks);
      const writeTarget = writeTargetOf(claim);
      // 写文件类断言不走通用的存在性核验：光「文件在」证明不了「我写的、而且没写坏」。
      const planned = curated ?? (writeTarget ? null : autoCheck(claim));
      const source = curated ? 'curated' : planned ? 'auto' : null;

      const wantAll = live === true || live === 'all';
      const wantLocal = live === 'local' || wantAll;
      const runNow = Boolean(planned) && (wantAll || (wantLocal && isLocalCheck(planned)));

      if (planned && !runNow) {
        note +=
          live === 'local' && !isLocalCheck(planned)
            ? `；可执行核验已就位（${describeCheck(planned)}），只在完整 --live 时跑`
            : `；可执行核验已就位（${describeCheck(planned)}），加 --live 才会跑`;
      } else if (runNow) {
        const r = runCheck(planned);
        if (r.crash) {
          note = `核验未能执行，不计为推翻：${r.crash}`;
          evidence.push({ grade: 'live', error: r.crash });
        } else {
          verdict = r.ok ? VERIFIED : REFUTED;
          grade = 'live';
          note = r.detail;
          evidence.push({ grade: 'live', ok: r.ok, detail: r.detail });
        }
      }

      // 写文件类断言：入参命中 + 文件存在 + 内容干净 才算 verified；
      // 入参命中但文件不在、或内容坏了 → 这是真矛盾，记 refuted。
      if (writeTarget && !curated) {
        const writes = writeCallsFor(writeTarget.value, evidencePool, claim.turn);
        if (!writes.length) {
          note = `写文件类断言，但本回合及之前的 write/edit 入参里没有 ${writeTarget.value}（只看调用参数，不看回显）`;
        } else if (!wantLocal) {
          note += `；写入调用已就位（${writes[0].name}），加 --live 才核对文件与编码`;
          evidence.push({ grade: 'call', tool: writes[0].name, callId: writes[0].callId, evidenceTurn: writes[0].turn });
        } else {
          const ex = runCheck({ type: 'path_exists', path: writeTarget.value });
          if (ex.crash) {
            note = `核验未能执行，不计为推翻：${ex.crash}`;
          } else if (!ex.ok) {
            verdict = REFUTED;
            grade = 'live';
            note = `${writes[0].name} 的入参碰过这个路径（turn ${writes[0].turn}），但文件不在：${writeTarget.value}`;
            evidence.push({ grade: 'live', ok: false, detail: ex.detail });
          } else {
            const clean = runCheck({ type: 'file_clean', path: writeTarget.value });
            if (clean.crash) {
              note = `文件在，但健康度核验没跑成：${clean.crash}`;
            } else if (!clean.ok) {
              verdict = REFUTED;
              grade = 'live';
              note = `文件在，但内容坏了：${clean.detail}`;
              evidence.push({ grade: 'live', ok: false, detail: clean.detail });
            } else {
              verdict = VERIFIED;
              grade = 'live';
              note = `${writes[0].name} 入参命中 + 文件存在 + ${clean.detail}`;
              evidence.push({ grade: 'live', ok: true, detail: clean.detail });
            }
          }
        }
      }

      // 探针：没有自动核验动作、也没有日志证据时，对本机路径做一次「只认存在、不认不存在」的检查。
      // 存在 → 至少能升到 verified（只证明路径在，不证明句中其它说法）；不存在 → 留 ?，不记推翻。
      if (!planned && !writeTarget && verdict !== VERIFIED && wantLocal && !NEGATIVE.test(claim.quote)) {
        const pathToken = claim.tokens.find((t) => t.kind === 'path' && !t.elided);
        if (pathToken && !insideMarkdownLink(claim.quote, pathToken.value)) {
          const r = runCheck({ type: 'path_exists', path: pathToken.value });
          if (!r.crash && r.ok) {
            verdict = VERIFIED;
            grade = 'live';
            note = `${r.detail}（只证明路径在，不证明句中其它说法）`;
            evidence.push({ grade: 'live', ok: true, detail: r.detail });
          } else if (!r.crash) {
            note += '；本机没有这个路径，但它没声明是自己刚创建的，不记推翻';
            evidence.push({ grade: 'live', ok: false, detail: r.detail });
          }
        }
      }

      rows.push({
        id: claim.id,
        turn: claim.turn,
        step: claim.step,
        quote: claim.quote,
        kind: claim.kind,
        stance: claim.stance,
        tokens: claim.tokens.map((t) => t.value),
        groundedCount,
        verdict,
        grade,
        note,
        check: planned ?? null,
        checkSource: source,
        evidence,
      });
    }
}

function summarize(rows, coverage) {
  const tally = (rows2) => ({
    total: rows2.length,
    verified: rows2.filter((r) => r.verdict === VERIFIED).length,
    refuted: rows2.filter((r) => r.verdict === REFUTED).length,
    unverifiable: rows2.filter((r) => r.verdict === UNVERIFIABLE).length,
  });

  const actions = rows.filter((r) => r.stance === 'action');
  const summary = {
    ...tally(rows),
    liveChecks: rows.filter((r) => r.grade === 'live').length,
    byStance: { action: tally(actions), report: tally(rows.filter((r) => r.stance !== 'action')) },
    coverage,
  };

  return summary;
}
