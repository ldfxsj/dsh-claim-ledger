import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS } from '../src/checks.mjs';
import { createRecorder } from '../src/auto.mjs';
import { readSnapshot } from '../src/store.mjs';
import { createTail } from '../src/tail.mjs';
import { writeCallsFor } from '../src/ledger.mjs';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-ledger-fix-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── 1. 核验不整读大文件 ────────────────────────────────────────────
test('file_contains：大文件只读前 2 MiB，并在 detail 里说明', () => {
  const { dir, cleanup } = tempDir();
  try {
    const big = join(dir, 'big.log');
    // 头部有 HIT，尾部也有 TAIL，但尾部在 2 MiB 之外
    const body = `HIT\n${'x'.repeat(3 * 1024 * 1024)}\nTAIL\n`;
    writeFileSync(big, body, 'utf8');

    const hit = CHECKS.file_contains({ path: big, pattern: 'HIT' });
    assert.equal(hit.ok, true);
    assert.match(hit.detail, /只读了前/);

    // 诚实：读不到的部分就不该说命中
    const miss = CHECKS.file_contains({ path: big, pattern: 'TAIL' });
    assert.equal(miss.ok, false);
    assert.match(miss.detail, /只读了前/);
  } finally {
    cleanup();
  }
});

test('file_clean：截断切在多字节字符中间也不算「不是合法 UTF-8」', () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = join(dir, 'cjk.md');
    // 「中」是 3 字节，2 MiB 边界正好切在字符中间
    writeFileSync(file, '中'.repeat(800_000), 'utf8');
    const result = CHECKS.file_clean({ path: file });
    assert.equal(result.ok, true, result.detail);
    assert.match(result.detail, /只检查了前/);
  } finally {
    cleanup();
  }
});

// ── 2. dispose 冲刷挂起作业 ────────────────────────────────────────
test('dispose：卸载前把已排队的回合写进快照，不丢掉最后一回合', () => {
  const { dir, cleanup } = tempDir();
  try {
    const recorder = createRecorder({ dir, debounceMs: 60_000 });
    const turns = [
      {
        turn: 1,
        assistant: [
          { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '已创建 D:\\x\\y.txt' }] } } },
        ],
        tools: [],
        ended: true,
        endReason: 'completed',
      },
    ];
    recorder.schedule({ sessionId: 'flushtest', turn: 1, turns });
    assert.equal(recorder.pending(), 1);

    recorder.dispose(); // 不等抖动窗口，直接卸载

    assert.equal(recorder.pending(), 0);
    const snapshot = readSnapshot('flushtest', { dir });
    assert.ok(snapshot, '卸载冲刷后应有快照');
    assert.equal(snapshot.turn, 1);
  } finally {
    cleanup();
  }
});

// ── 3. tail 内存有上界 ────────────────────────────────────────────
test('tail：原始事件数组有上限，回合可以按「已交付」丢旧留新', () => {
  const tail = createTail();
  const total = 1200;
  for (let t = 1; t <= total; t += 1) {
    tail.push('s', {
      type: 'assistant/message',
      seq: t,
      data: { turn: t, message: { content: [{ type: 'text', text: `第 ${t} 回合` }] } },
    });
    tail.push('s', { type: 'turn/end', seq: t + 0.5, data: { turn: t, reason: { kind: 'completed' } } });
  }

  assert.equal(tail.size('s'), 1000, '原始事件只留最近 1000 条');
  assert.equal(tail.turns('s').length, total);

  const dropped = tail.trim('s', 400);
  assert.equal(dropped, total - 400);
  const kept = tail.turns('s');
  assert.equal(kept.length, 400);
  assert.equal(kept[kept.length - 1].turn, total, '最新的回合必须留着');
  assert.equal(kept[0].turn, total - 399);
});

// ── 4. 路径匹配不区分大小写 ───────────────────────────────────────
test('writeCallsFor：Windows 路径大小写不同也算同一条', () => {
  // 运行时看到的是 argsText 归一化之后的样子：单反斜杠（不是 JSON 里的双反斜杠）
  const pool = [
    { kind: 'call', name: 'write', turn: 1, argsText: '{"path":"D:\\deepseek\\Notes\\a.md","content":"x"}' },
    { kind: 'call', name: 'read', turn: 1, argsText: '{"path":"D:\\deepseek\\notes\\a.md"}' },
  ];
  const hit = writeCallsFor('D:\\deepseek\\notes\\a.md', pool, 2);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, 'write', 'read 的入参不算写入证据');
});
