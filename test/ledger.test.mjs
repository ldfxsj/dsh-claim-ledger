import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { groupTurns } from '../src/session.mjs';
import { extractClaims, sentencesOf } from '../src/extract.mjs';
import { audit } from '../src/ledger.mjs';
import { renderBadge, renderTable } from '../src/render.mjs';

let seq = 0;
const next = () => (seq += 1);

function assistant(turn, step, text) {
  return { type: 'assistant/message', seq: next(), data: { turn, step, message: { content: [{ type: 'text', text }] } } };
}
function toolCall(turn, step, callId, name, args) {
  const data = { turn, step, callId, name };
  if (args !== undefined) data.arguments = args;
  return { type: 'tool/call', seq: next(), data };
}
function toolResult(turn, step, callId, text) {
  return { type: 'tool/result', seq: next(), data: { turn, step, toolCallId: callId, message: { content: [{ type: 'text', text }] } } };
}

function session(events) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n'));
  return { events, turns: groupTurns(events) };
}

test('抽取：只留带事实 token 的句子，代码块不算断言', () => {
  const text = [
    '已经弄好了，一切正常。',
    '共 13,136 个插件，23 个分类。',
    '```',
    '版本 9.9.9 在代码块里',
    '```',
  ].join('\n');

  assert.ok(sentencesOf(text).some((s) => s.includes('13,136')), '分词本身保留所有句子');

  const { turns } = session([assistant(1, 1, text)]);
  const claims = extractClaims(turns[0]);
  assert.ok(!claims.some((c) => c.quote.includes('已经弄好了')), '无 token 的句子不该成为断言');
  assert.ok(claims.some((c) => c.quote.includes('13,136')));
  assert.ok(!claims.some((c) => c.quote.includes('9.9.9')), '代码块内容被剔除');
});

test('判定：事实出现在本轮工具输出 → verified(log)', () => {
  const { turns } = session([
    assistant(1, 1, '共 13136 个插件，23 个分类。'),
    toolCall(1, 1, 'call_a', 'node'),
    toolResult(1, 1, 'call_a', 'count=13136 categories=23'),
  ]);
  const { claims, summary } = audit({ turns });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].verdict, 'verified');
  assert.equal(claims[0].grade, 'log');
  assert.equal(summary.verified, 1);
});

test('判定：工具输出里没有这个事实 → unverifiable（不是 refuted）', () => {
  const { turns } = session([
    assistant(1, 1, '共有 99999 个插件。'),
    toolCall(1, 1, 'call_a', 'node'),
    toolResult(1, 1, 'call_a', 'count=13136'),
  ]);
  const { claims, summary } = audit({ turns });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.equal(summary.unverifiable, 1);
  assert.equal(summary.refuted, 0);
});

test('判定：现场核验矛盾 → refuted(live)', () => {
  const q = '版本 1.0.15 已核实。';
  const { turns } = session([assistant(1, 1, q)]);
  const checks = { [q]: { type: 'command', argv: ['node', '-e', 'process.exit(1)'], expectExit: 0 } };
  const { claims, summary } = audit({ turns, checks, live: true });
  assert.equal(claims[0].verdict, 'refuted');
  assert.equal(claims[0].grade, 'live');
  assert.equal(summary.refuted, 1);
  assert.equal(summary.verified, 0);
});

test('核验跑不起来 → 仍为 unverifiable，绝不记推翻', () => {
  const q = '版本 1.0.15 已核实。';
  const { turns } = session([assistant(1, 1, q)]);
  const checks = { [q]: { type: 'command', argv: ['rm', '-rf', '/'], expectExit: 0 } };
  const { claims, summary } = audit({ turns, checks, live: true });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.equal(summary.refuted, 0);
  assert.match(claims[0].note, /不在白名单|未能执行/);
});

test('跨轮引用：后一轮引用前一轮工具输出证实的事实 → verified', () => {
  const { turns } = session([
    toolCall(1, 1, 'c1', 'node'),
    toolResult(1, 1, 'c1', 'count=13136'),
    assistant(2, 1, '正如前面说的，共 13136 个插件。'),
  ]);
  const { claims } = audit({ turns, onlyTurns: [2] });
  assert.equal(claims[0].verdict, 'verified');
  assert.equal(claims[0].evidence[0].evidenceTurn, 1);
});

test('证据不能来自未来：断言之后的工具输出不能回溯证明它', () => {
  const { turns } = session([
    assistant(1, 1, '本次共处理 13136 个文件。'),
    toolCall(2, 1, 'c1', 'node'),
    toolResult(2, 1, 'c1', 'count=13136'),
  ]);
  const { claims } = audit({ turns, onlyTurns: [1] });
  assert.equal(claims[0].verdict, 'unverifiable');
});

test('自动核验：说“已删除 <路径>”会绑到 path_absent', () => {
  const missing = join(tmpdir(), 'definitely-not-here-9f3a2b');
  const { turns } = session([assistant(1, 1, `临时目录 ${missing} 已删除。`)]);
  const { claims } = audit({ turns, live: true });
  assert.equal(claims[0].checkSource, 'auto');
  assert.equal(claims[0].check.type, 'path_absent');
  assert.equal(claims[0].verdict, 'verified');
});

test('抽取：markdown 的 <D:\\…> 不能把尖括号吃进路径 token', () => {
  const { turns } = session([assistant(1, 1, '成品在 [a.docx](<D:\\x\\a.docx>)，预览图见下方。')]);
  const claims = extractClaims(turns[0]);
  assert.equal(claims[0].tokens[0].kind, 'path');
  assert.equal(claims[0].tokens[0].value, 'D:\\x\\a.docx');
});

test('自动核验：说“成品在 <路径>”绑 path_exists，按文件系统判定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-out-'));
  const file = join(dir, 'out.txt');
  writeFileSync(file, 'x');
  const { turns } = session([assistant(1, 1, `成品在 [out.txt](<${file}>)，预览图见下方。`)]);
  const { claims } = audit({ turns, live: true });
  assert.equal(claims[0].checkSource, 'auto');
  assert.equal(claims[0].check.type, 'path_exists');
  assert.equal(claims[0].verdict, 'verified');
});

test('立场：第一人称算 action，产品介绍算 report，徽章分开数', () => {
  const { turns } = session([
    assistant(
      1,
      1,
      ['我装好了 dsh-claim-ledger 0.2.0。', '**`dsh-pua`**（25,898）能逼它在失败后换方法。'].join('\n'),
    ),
  ]);
  const { claims, summary } = audit({ turns });
  const byQuote = (needle) => claims.find((c) => c.quote.includes(needle));
  assert.equal(byQuote('我装好了').stance, 'action');
  assert.equal(byQuote('dsh-pua').stance, 'report');
  assert.equal(summary.byStance.action.total, 1);
  assert.equal(summary.byStance.report.total, 1);
});

test('立场过滤：stance=action 只返回行动类', () => {
  const { turns } = session([
    assistant(1, 1, ['我删掉了 123 个临时文件。', '共 13136 个插件。'].join('\n')),
  ]);
  const { claims, summary } = audit({ turns, stance: 'action' });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].stance, 'action');
  assert.equal(summary.total, 1);
  assert.equal(summary.byStance.report.total, 0);
});

test('否认类行动断言：token 出现过 ≠ 做不到，不能靠日志升级', () => {
  const { turns } = session([
    assistant(1, 1, '插件 `D:\\apps\\x` 我装不了，approval 被禁用。'),
    toolCall(1, 1, 'c1', 'plugin_manager'),
    toolResult(1, 1, 'c1', '+ dsh-claim-ledger 0.1.0 <- D:\\apps\\x'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.match(claims[0].note, /否认/);
});

test('否认类行动断言：工具输出里确实有报错 → 可以 verified', () => {
  const { turns } = session([
    assistant(1, 1, '插件 `D:\\apps\\x` 我装不了。'),
    toolCall(1, 1, 'c1', 'plugin_manager'),
    toolResult(1, 1, 'c1', 'Error: EACCES permission denied: D:\\apps\\x'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'verified');
  assert.equal(claims[0].grade, 'log');
});

test('探针：没动作词的路径断言，本机存在就升到 verified，不存在也不记推翻', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-probe-'));
  const exists = join(dir, 'a.txt');
  writeFileSync(exists, 'x');
  const missing = join(dir, 'b.txt');

  const { turns } = session([
    assistant(1, 1, `\`${exists}\` 是一个 junction 指向别处。`),
    assistant(1, 2, `\`${missing}\` 也是一个 junction。`),
  ]);
  const { claims } = audit({ turns, live: 'local' });
  const hit = claims.find((c) => c.quote.includes('a.txt'));
  const miss = claims.find((c) => c.quote.includes('b.txt'));

  assert.equal(hit.verdict, 'verified');
  assert.equal(hit.grade, 'live');
  assert.match(hit.note, /只证明路径在/);
  assert.equal(miss.verdict, 'unverifiable', '没有存在性动词时不因路径缺失而推翻');
  assert.equal(miss.grade, 'none');
});

test('探针不动纯 markdown 链接里的路径（用户 2026-11-26 的决定）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-link-'));
  const target = join(dir, 'preview.png');
  writeFileSync(target, 'x');
  const { turns } = session([assistant(1, 1, `预览图见 [第一页](${target})。`)]);
  const { claims, summary } = audit({ turns, live: 'local' });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.equal(summary.liveChecks, 0);
});

test('省略号截断的路径不是事实：不去探、不谎报“本机没有”', () => {
  const { turns } = session([assistant(1, 1, '这个 bug 会把 `<D:\\…docx>` 连尖括号吃进 token。')]);
  const { claims } = audit({ turns, live: 'local' });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.match(claims[0].note, /省略号|截断/);
  assert.ok(!claims[0].evidence.some((e) => e.grade === 'live'), '截断路径不该触发存在性探针');
});

test('一句里同时有真路径和省略号路径：只要求真路径出现在证据里', () => {
  const { turns } = session([
    assistant(1, 1, '我把 D:\\deepseek\\a.txt 删了（另外提到 D:\\…docx）。'),
    toolCall(1, 1, 'call_a', 'pwsh'),
    toolResult(1, 1, 'call_a', 'removed D:\\deepseek\\a.txt'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'verified');
  assert.equal(claims[0].groundedCount, 1);
});

test('转述引号里的话不算我的行动：stance 只看引号外', () => {
  const { turns } = session([assistant(1, 1, '这条最值钱：`「Plugins → 选 D:\\deepseek\\claim-ledger（我装不了）」` 以前会被判 ✓。')]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].stance, 'report');
});

test('否认类不论立场都不能靠路径存在升级', () => {
  const { turns } = session([
    assistant(1, 1, '`「Plugins → 选 D:\\deepseek\\claim-ledger（我装不了）」` 以前会被判 ✓。'),
    toolCall(1, 1, 'call_a', 'pwsh'),
    toolResult(1, 1, 'call_a', 'D:\\deepseek\\claim-ledger exists'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.match(claims[0].note, /否认/);
});

test('反引号只包住路径时，句子仍是行动类', () => {
  const { turns } = session([assistant(1, 1, '我把 `D:\\deepseek\\x.txt` 删了。')]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].stance, 'action');
});

// ── V0.3：写入取证 ─────────────────────────────────────────────

test('归并：tool/call 的 arguments 被保留，反斜杠解回单层', () => {
  const { turns } = session([toolCall(1, 1, 'c1', 'write', { path: 'D:\\deepseek\\a.md', content: 'x' })]);
  assert.equal(turns[0].calls.length, 1);
  assert.equal(turns[0].calls[0].name, 'write');
  assert.match(turns[0].calls[0].argsText, /D:\\deepseek\\a\.md/);
  assert.ok(!turns[0].calls[0].argsText.includes('\\\\'), '入参里的双反斜杠要解掉，否则永远匹配不上');
});

test('归并：日志里的 arguments 是 JSON 字符串，不能被双层转义', () => {
  // 真实日志形状：arguments 是 "{ \"file_path\": \"D:\\\\deepseek\\\\a.md\" }" 这类字符串
  const raw = JSON.stringify({ file_path: 'D:\\deepseek\\a.md' });
  const { turns } = session([toolCall(1, 1, 'c1', 'write', raw)]);
  assert.match(turns[0].calls[0].argsText, /D:\\deepseek\\a\.md/);
  assert.ok(!turns[0].calls[0].argsText.includes('\\\\'), '双层转义会让路径比对全部落空');
});

test('写入取证：write 入参命中 + 文件存在 + 干净 → verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-write-'));
  const file = join(dir, 'note.md');
  writeFileSync(file, '# 标题\n内容正常。\n');
  const { turns } = session([
    toolCall(1, 1, 'c1', 'write', { path: file, content: '# 标题\n内容正常。\n' }),
    toolResult(1, 1, 'c1', 'Updated file'),
    assistant(1, 2, `我把 ${file} 重写了一遍。`),
  ]);
  const { claims } = audit({ turns, live: 'local' });
  assert.equal(claims[0].verdict, 'verified');
  assert.equal(claims[0].grade, 'live');
  assert.match(claims[0].note, /入参命中/);
});

test('写入取证：入参命中但文件不在 → refuted', () => {
  const missing = join(tmpdir(), 'ledger-write-missing', 'gone.md');
  const { turns } = session([
    toolCall(1, 1, 'c1', 'write', { path: missing }),
    toolResult(1, 1, 'c1', 'Updated file'),
    assistant(1, 2, `我把 ${missing} 写好了。`),
  ]);
  const { claims } = audit({ turns, live: 'local' });
  assert.equal(claims[0].verdict, 'refuted');
  assert.match(claims[0].note, /文件不在/);
});

test('写入取证：文件在但内容坏了（BOM + 替换字符）→ refuted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-write-broken-'));
  const file = join(dir, 'bad.md');
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题 \uFFFD 坏了\n', 'utf8')]));
  const { turns } = session([
    toolCall(1, 1, 'c1', 'edit', { path: file }),
    toolResult(1, 1, 'c1', 'Updated file'),
    assistant(1, 2, `我把 ${file} 更新好了。`),
  ]);
  const { claims } = audit({ turns, live: 'local' });
  assert.equal(claims[0].verdict, 'refuted');
  assert.match(claims[0].note, /BOM|替换字符/);
});

test('写入取证：没有写入调用时，文件存在也不能升级（探针不介入）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-write-nocall-'));
  const file = join(dir, 'exists.md');
  writeFileSync(file, 'ok\n');
  const { turns } = session([assistant(1, 1, `我把 ${file} 重写了一遍。`)]);
  const { claims } = audit({ turns, live: 'local' });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.match(claims[0].note, /入参里没有/);
  assert.ok(!claims[0].evidence.some((e) => e.grade === 'live'), '没有写入调用就不该去探文件');
});

test('写入取证：读文件类调用的入参不算写入证据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-write-read-'));
  const file = join(dir, 'read.md');
  writeFileSync(file, 'ok\n');
  const { turns } = session([
    toolCall(1, 1, 'c1', 'read', { path: file }),
    toolResult(1, 1, 'c1', 'ok'),
    assistant(1, 2, `我把 ${file} 重写了一遍。`),
  ]);
  const { claims } = audit({ turns, live: 'local' });
  assert.equal(claims[0].verdict, 'unverifiable');
});

test('覆盖率：完成式句子按有无 token 分成「可查」与「进不了表」', () => {
  const { turns } = session([
    assistant(
      1,
      1,
      [
        `我已经把 ${join(tmpdir(), 'x.md')} 写好了。`,
        '碰撞箱已经修好了。',
        'README 里也写好了这一节。',
        '跑通了再谈扩展。',
      ].join('\n'),
    ),
  ]);
  const { claims, summary } = audit({ turns, live: 'local' });
  assert.equal(summary.coverage.completions, 3, '条件句不算完成性断言');
  assert.equal(summary.coverage.backed, 1);
  assert.equal(summary.coverage.unbacked, 2);
  assert.equal(summary.coverage.examples.length, 2);
  assert.equal(claims.length, 1, '台账只收带 token 的句子');
});

test('覆盖率：徽章带上「覆盖 N%」，没有完成性断言时不显示', () => {
  const withCov = renderBadge({ total: 3, verified: 2, refuted: 0, unverifiable: 1, coverage: { completions: 4, backed: 1, unbacked: 3, examples: [] } });
  assert.match(withCov, /覆盖 25%/);
  const without = renderBadge({ total: 1, verified: 1, refuted: 0, unverifiable: 0 });
  assert.ok(!/覆盖/.test(without));
});

test('覆盖率：表格末尾给出句子数、可查比例与未取证的例子', () => {
  const text = renderTable(
    {
      claims: [],
      summary: {
        total: 0,
        verified: 0,
        refuted: 0,
        unverifiable: 0,
        coverage: { completions: 10, backed: 2, unbacked: 8, examples: [{ turn: 3, quote: 'README 里也写好了这一节。' }] },
      },
    },
    { width: 100 },
  );
  assert.match(text, /完成性断言 10 句/);
  assert.match(text, /有 token 可查 2 句（20%）/);
  assert.match(text, /t3 README 里也写好了这一节/);
});

