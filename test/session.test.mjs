import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { decodeZstd, frameOffsets, loadSession } from '../src/session.mjs';

const line = (obj) => `${JSON.stringify(obj)}\n`;

test('多帧 zstd 日志要全部读出来，不能只读第一帧', () => {
  const first = line({ type: 'session', seq: 0, data: { id: 's' } });
  const second = line({ type: 'assistant/message', seq: 1, data: { turn: 1 } });
  const third = line({ type: 'tool/result', seq: 2, data: { turn: 1 } });
  const buf = Buffer.concat([
    zstdCompressSync(Buffer.from(first, 'utf8')),
    zstdCompressSync(Buffer.from(second, 'utf8')),
    zstdCompressSync(Buffer.from(third, 'utf8')),
  ]);

  assert.equal(frameOffsets(buf).length, 3, '必须认出三个帧的 magic，否则只会读到第一帧');
  assert.equal(decodeZstd(buf).toString('utf8'), first + second + third);

  const dir = mkdtempSync(join(tmpdir(), 'claim-ledger-zstd-'));
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, buf);
    const { events, skipped } = loadSession(file);
    assert.equal(skipped, 0);
    assert.deepEqual(events.map((e) => e.type), ['session', 'assistant/message', 'tool/result']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
