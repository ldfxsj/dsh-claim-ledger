import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupTurns } from '../src/session.mjs';
import { audit, runEvidence } from '../src/ledger.mjs';

let seq = 0;
const next = () => (seq += 1);

function assistant(turn, step, text) {
  return { type: 'assistant/message', seq: next(), data: { turn, step, message: { content: [{ type: 'text', text }] } } };
}
function toolCall(turn, step, callId, name) {
  return { type: 'tool/call', seq: next(), data: { turn, step, callId, name } };
}
function toolResult(turn, step, callId, text) {
  return { type: 'tool/result', seq: next(), data: { turn, step, toolCallId: callId, message: { content: [{ type: 'text', text }] } } };
}
const turnsOf = (events) => groupTurns(events);

test('跑通类断言：本回合执行输出里有成功标志 → verified(tool)', () => {
  const turns = turnsOf([
    assistant(1, 1, '刚才那批测试已经跑通了。'),
    toolCall(1, 1, 'c1', 'pwsh'),
    toolResult(1, 1, 'c1', 'Tests 5 passed, 0 failed.'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'run');
  assert.equal(claims[0].verdict, 'verified');
  assert.equal(claims[0].grade, 'tool');
});

test('跑通类断言：输出里写了 N 个失败 → refuted（哪怕也写了 passed）', () => {
  const turns = turnsOf([
    assistant(1, 1, '刚才那批测试已经跑通了。'),
    toolCall(1, 1, 'c1', 'pwsh'),
    toolResult(1, 1, 'c1', 'tests 5 passed, 2 failed'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'refuted');
  assert.match(claims[0].note, /2 个失败/);
});

test('跑通类断言：非执行类工具的输出不算成败证据', () => {
  // 真实假阳性：`compress` 的输出里恰好有个 ✓，曾把「自动记账已经跑通了」判成 verified
  const turns = turnsOf([
    assistant(1, 1, '自动记账已经跑通了。'),
    toolCall(1, 1, 'c1', 'compress'),
    toolResult(1, 1, 'c1', '[Compressed 3 blocks ✓ success]'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.match(claims[0].note, /测不到/);
});

test('跑通类断言：只有失败字样、没有成功标志 → 不推翻，留 ?', () => {
  const turns = turnsOf([
    assistant(1, 1, '刚才那批测试已经跑通了。'),
    toolCall(1, 1, 'c1', 'pwsh'),
    toolResult(1, 1, 'c1', 'warning: an error appeared in some unrelated log line'),
  ]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.match(claims[0].note, /失败字样/);
});

test('跑通类断言：本回合没有任何执行输出 → ?，并说明测不到', () => {
  const turns = turnsOf([assistant(1, 1, '插件已经跑通了。')]);
  const { claims } = audit({ turns });
  assert.equal(claims[0].verdict, 'unverifiable');
  assert.match(claims[0].note, /没有执行类工具/);
});

test('覆盖率：跑通类句子有成败标志时算「可查」，不再算「测不到」', () => {
  const turns = turnsOf([
    assistant(1, 1, '刚才那批测试已经跑通了。'),
    toolCall(1, 1, 'c1', 'pwsh'),
    toolResult(1, 1, 'c1', 'all tests passed'),
  ]);
  const { summary } = audit({ turns });
  assert.equal(summary.coverage.completions, 1);
  assert.equal(summary.coverage.backed, 1);
  assert.equal(summary.coverage.unbacked, 0);
});

test('runEvidence：只看本回合，且只认执行类工具', () => {
  const pool = [
    { name: 'pwsh', turn: 2, text: 'all tests passed' },
    { name: 'compress', turn: 1, text: '✓ success' },
  ];
  assert.equal(runEvidence(pool, 1), null, '第 1 回合只有 compress，不算');
  assert.ok(runEvidence(pool, 2), '第 2 回合有 pwsh 的成功标志');
});
