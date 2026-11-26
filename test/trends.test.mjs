import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJournal, summarizeJournal, claimStats, readSnapshots, kindOfClaim, trends } from '../src/trends.mjs';
import { saveSnapshot } from '../src/store.mjs';
import { renderTrends } from '../src/render.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'claim-trends-'));
}

test('readJournal 跳过坏行并计数', () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'journal.jsonl'),
    [
      JSON.stringify({ sessionId: 'a', turn: 1, claims: 3, verified: 3, refuted: 0, unverifiable: 0 }),
      'not json',
      JSON.stringify({ sessionId: 'a', turn: 2, claims: 2, verified: 0, refuted: 0, unverifiable: 2 }),
      '',
    ].join('\n'),
    'utf8',
  );
  const { entries, skipped } = readJournal({ dir });
  assert.equal(entries.length, 2);
  assert.equal(skipped, 1);
});

test('summarizeJournal 找到每个会话首个出现 ? 的回合', () => {
  const entries = [
    { sessionId: 'a', turn: 1, claims: 3, verified: 3, refuted: 0, unverifiable: 0 },
    { sessionId: 'a', turn: 2, claims: 2, verified: 0, refuted: 0, unverifiable: 2 },
    { sessionId: 'b', turn: 1, claims: 1, verified: 1, refuted: 0, unverifiable: 0 },
    { sessionId: 'b', turn: 2, claims: 1, verified: 0, refuted: 1, unverifiable: 0 },
  ];
  const { sessions, totals } = summarizeJournal(entries);
  const a = sessions.find((s) => s.sessionId === 'a');
  const b = sessions.find((s) => s.sessionId === 'b');
  assert.equal(a.firstUnknownTurn, 2);
  assert.equal(a.turns, 2);
  assert.equal(a.claims, 5);
  assert.equal(b.firstUnknownTurn, null);
  assert.equal(totals.sessions, 2);
  assert.equal(totals.claims, 7);
  assert.equal(totals.sessionsWithUnknown, 1);
});

test('kindOfClaim 区分路径、版本号与数字', () => {
  assert.equal(kindOfClaim({ tokens: ['D:\\deepseek\\a.docx'] }), 'path');
  assert.equal(kindOfClaim({ tokens: ['0.2.1'] }), 'version');
  assert.equal(kindOfClaim({ tokens: ['13,136'] }), 'number');
});

test('claimStats 指出从没被核实过的类型', () => {
  const snapshots = [
    {
      claims: [
        { stance: 'action', tokens: ['D:\\a.txt'], verdict: 'verified', quote: '已删掉 D:\\a.txt' },
        { stance: 'report', tokens: ['1.2.3'], verdict: 'unverifiable', quote: '当时是 1.2.3' },
        { stance: 'report', tokens: ['2.0.0'], verdict: 'unverifiable', quote: '另一个 2.0.0' },
      ],
    },
  ];
  const stats = claimStats(snapshots);
  const never = stats.never.map((r) => r.key);
  assert.deepEqual(never, ['report/version']);
  assert.equal(stats.rows.find((r) => r.key === 'action/path').verified, 1);
  assert.equal(stats.examples.get('report/version').length, 2);
});

test('readSnapshots 跳过坏文件', () => {
  const dir = tempDir();
  saveSnapshot('good', { sessionId: 'good', claims: [] }, { dir });
  writeFileSync(join(dir, 'broken.json'), '{oops', 'utf8');
  const { snapshots, skipped } = readSnapshots({ dir });
  assert.equal(snapshots.length, 1);
  assert.equal(skipped, 1);
});

test('trends 汇总 journal 与快照，渲染出走势表', () => {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'journal.jsonl'),
    `${JSON.stringify({ sessionId: 'session-3ccad9ef', turn: 1, claims: 4, verified: 4, refuted: 0, unverifiable: 0 })}\n${JSON.stringify(
      { sessionId: 'session-3ccad9ef', turn: 2, claims: 2, verified: 0, refuted: 0, unverifiable: 2 },
    )}\n`,
    'utf8',
  );
  saveSnapshot('session-3ccad9ef', {
    sessionId: 'session-3ccad9ef',
    claims: [{ stance: 'report', tokens: ['0.5.9'], verdict: 'refuted', quote: 'dsh-talk-map 是 0.5.9' }],
  }, { dir });

  const report = trends({ dir });
  assert.equal(report.journal.totals.turns, 2);
  assert.equal(report.snapshots, 1);

  const text = renderTrends(report);
  assert.match(text, /走势/);
  assert.match(text, /首个\?/);
  assert.match(text, /t2/);
  assert.match(text, /陈述·版本号/);
  assert.match(text, /被推翻 1 条/);
});

test('没有 journal 时给出一句话而不是空表', () => {
  const text = renderTrends(trends({ dir: tempDir() }));
  assert.match(text, /还没有 journal\.jsonl/);
});
