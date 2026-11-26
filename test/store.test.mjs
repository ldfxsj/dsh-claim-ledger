import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLedger, readErrors, saveSnapshot, snapshotPath } from '../src/store.mjs';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-ledger-store-'));
  return dir;
}

test('清理：只留最近的快照，旧的删掉', () => {
  const dir = tempDir();
  const now = Date.UTC(2026, 10, 26);
  for (let i = 0; i < 6; i += 1) {
    const id = `s${i}`;
    saveSnapshot(id, { sessionId: id, turn: i }, { dir });
    const at = (now - i * 60_000) / 1000;
    utimesSync(snapshotPath(id, dir), at, at);
  }

  const result = pruneLedger({ dir, keepSnapshots: 3, maxAgeDays: 30, now: () => now });

  assert.equal(result.snapshots, 3);
  assert.equal(existsSync(snapshotPath('s0', dir)), true, '最新三个之一必须留下');
  assert.equal(existsSync(snapshotPath('s5', dir)), false, '最旧的应被清理');
});

test('清理：超过上限的 journal 只留尾巴', () => {
  const dir = tempDir();
  const journal = join(dir, 'journal.jsonl');
  const line = `{"at":"2026-01-01T00:00:00.000Z","sessionId":"s","claims":1}\n`;
  writeFileSync(journal, line.repeat(2000), 'utf8');

  const result = pruneLedger({ dir, journalMaxBytes: 1024, now: () => Date.now() });

  assert.equal(result.journals, 1);
  const kept = readFileSync(journal, 'utf8');
  assert.ok(kept.length < line.length * 2000, '应该变小');
  assert.ok(kept.startsWith('{"at"'), '留下的仍应是完整的 JSON 行，不是半行');
});

test('errors.log：没有文件时说没有，有文件时给尾巴', () => {
  const dir = tempDir();
  assert.deepEqual(readErrors({ dir }).lines, []);

  writeFileSync(join(dir, 'errors.log'), ['a', 'b', 'c', 'd'].map((x) => `[t] ${x}`).join('\n') + '\n', 'utf8');
  const { lines, file } = readErrors({ dir, limit: 2 });

  assert.equal(lines.length, 2);
  assert.match(lines[1], /d$/);
  assert.equal(file, join(dir, 'errors.log'));
});
