import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, createRecorder } from '../src/auto.mjs';
import { groupTurns, loadSession } from '../src/session.mjs';
import { createTail } from '../src/tail.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sample = join(here, '..', 'samples', 'demo-session.jsonl');
const readme = join(here, '..', 'README.md');

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-ledger-auto-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function turnWith(turn, quote, toolText = '') {
  return {
    turn,
    assistant: [{ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: quote }] } } }],
    tools: toolText ? [{ callId: `c${turn}`, name: 'pwsh', text: toolText }] : [],
    ended: true,
    endReason: 'completed',
  };
}

test('快照：日志证据给 ✓，本机文件核验能给出 ✗', () => {
  const turns = [
    turnWith(1, '`dsh-see-now` 已经到 0.2.9 了', 'dsh-see-now -> 0.2.9'),
    turnWith(2, `已删除 D:\\deepseek\\claim-ledger\\README.md，不留备份。`),
  ];

  const snapshot = buildSnapshot({ sessionId: 's1', turns, turn: 2, recordedAt: '2026-01-01T00:00:00.000Z' });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.summary.total, 2);
  assert.equal(snapshot.summary.verified, 1, '有工具输出佐证的版本号应为 verified');
  assert.equal(snapshot.summary.refuted, 1, 'README.md 明明在，却断言已删除 → refuted');
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[1].refuted, 1);
  assert.ok(existsSync(readme), '前提：README.md 存在，否则这条测试不再验证 refuted');
});

test('快照：没有证据的句子是 ?，不是通过', () => {
  const snapshot = buildSnapshot({ sessionId: 's1', turns: [turnWith(1, 'treg 索引了 2,600 个外部接口。')] });
  assert.equal(snapshot.summary.total, 1);
  assert.equal(snapshot.summary.unverifiable, 1);
});

test('recorder：回合结束后落快照与 journal', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const turns = groupTurns(loadSession(sample).events);
    const recorder = createRecorder({ dir, debounceMs: 5 });
    recorder.schedule({ sessionId: 'abc', file: sample, turn: 1, turns });
    assert.equal(recorder.pending(), 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(recorder.pending(), 0);

    const snapshot = JSON.parse(readFileSync(join(dir, 'abc.json'), 'utf8'));
    assert.equal(snapshot.sessionId, 'abc');
    assert.equal(snapshot.turn, 1);
    assert.equal(snapshot.summary.total, 3);
    assert.equal(snapshot.summary.verified, 2, '两条版本号有工具输出佐证');
    assert.equal(snapshot.summary.unverifiable, 1, '2,600 没有证据');

    const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n');
    assert.equal(journal.length, 1);
    assert.equal(JSON.parse(journal[0]).claims, 3);
    recorder.dispose();
  } finally {
    cleanup();
  }
});

test('recorder：连着的两次调度只写一次', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const turns = groupTurns(loadSession(sample).events);
    const recorder = createRecorder({ dir, debounceMs: 10 });
    recorder.schedule({ sessionId: 'abc', turns, turn: 1 });
    recorder.schedule({ sessionId: 'abc', turns, turn: 1 });
    await new Promise((r) => setTimeout(r, 40));
    const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n');
    assert.equal(journal.length, 1, '抖动窗口内的重复调度应该合并');
    recorder.dispose();
  } finally {
    cleanup();
  }
});

test('recorder：增量喂回合，结果与全量审计一致且不重复计数', () => {
  const { dir, cleanup } = tempDir();
  try {
    const turns = [
      turnWith(1, '`dsh-see-now` 已经到 0.2.9 了', 'dsh-see-now -> 0.2.9'),
      turnWith(2, '我把 demo 写好了', ''),
      turnWith(3, 'treg 索引了 2,600 个外部接口。', ''),
    ];
    const recorder = createRecorder({ dir, debounceMs: 1 });
    // 第一次只喂到 turn 1，第二次喂全量（真实链路每次都传 tail.turns(id) 的全部回合）
    recorder.recordNow({ sessionId: 'inc', turns: turns.slice(0, 1), turn: 1 });
    const second = recorder.recordNow({ sessionId: 'inc', turns, turn: 3 });
    const full = buildSnapshot({ sessionId: 'inc', turns, turn: 3 });

    assert.equal(second.summary.total, full.summary.total, '增量与全量应给出同样的断言数');
    assert.deepEqual(
      second.claims.map((c) => [c.quote, c.verdict]),
      full.claims.map((c) => [c.quote, c.verdict]),
      '逐条判定也应一致',
    );
    assert.equal(second.turns.length, 3);
    recorder.dispose();
  } finally {
    cleanup();
  }
});

test('recorder：forget 之后重新从零算（会话结束不留内存尾巴）', () => {
  const { dir, cleanup } = tempDir();
  try {
    const turns = [turnWith(1, 'treg 索引了 2,600 个外部接口。')];
    const recorder = createRecorder({ dir, debounceMs: 1 });
    const first = recorder.recordNow({ sessionId: 'forget-me', turns, turn: 1 });
    recorder.forget('forget-me');
    const second = recorder.recordNow({ sessionId: 'forget-me', turns, turn: 1 });
    assert.equal(first.summary.total, 1);
    assert.equal(second.summary.total, 1, 'forget 后重新 ingest，不应重复也不应清空');
    recorder.dispose();
  } finally {
    cleanup();
  }
});

test('recorder：算账崩了写 errors.log，绝不抛出', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const recorder = createRecorder({
      dir,
      debounceMs: 5,
      build: () => {
        throw new Error('boom');
      },
    });
    recorder.schedule({ sessionId: 'abc', turns: [], turn: 1 });
    await new Promise((r) => setTimeout(r, 40));
    const log = readFileSync(join(dir, 'errors.log'), 'utf8');
    assert.match(log, /记账失败 session=abc turn=1: boom/);
    assert.equal(existsSync(join(dir, 'abc.json')), false);
    recorder.dispose();
  } finally {
    cleanup();
  }
});

test('tail：seed 与实时事件按 seq 去重，回合仍能归并', () => {
  const { events } = loadSession(sample);
  const tail = createTail();
  tail.seed('s', events);
  tail.push('s', events[1]); // 重复的 seq 应被丢掉
  tail.push('s', { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } });

  assert.equal(tail.size('s'), 5);
  const turns = tail.turns('s');
  assert.deepEqual(turns.map((t) => t.turn), [1, 2]);
  assert.equal(turns[1].ended, true);
});
