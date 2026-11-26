import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, curatedFor } from '../src/ledger.mjs';
import { groupTurns } from '../src/session.mjs';
import { renderUnbacked } from '../src/render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readme = join(here, '..', 'README.md');

let seq = 0;
const next = () => (seq += 1);
const assistant = (turn, step, text) => ({
  type: 'assistant/message',
  seq: next(),
  data: { turn, step, message: { content: [{ type: 'text', text }] } },
});

test('curatedFor：精确原文、规则数组、坏正则三种形状', () => {
  const exact = { '我把 X 写好了': { type: 'path_exists', path: 'D:\\x' } };
  assert.deepEqual(curatedFor('我把 X 写好了', exact), { type: 'path_exists', path: 'D:\\x' });

  const rules = { rules: [{ pattern: '删除了', check: { type: 'path_absent', path: 'D:\\gone' } }] };
  assert.deepEqual(curatedFor('我已经删除了 D:\\gone', rules), { type: 'path_absent', path: 'D:\\gone' });
  assert.equal(curatedFor('完全无关的一句话', rules), null);

  const arrayForm = [{ pattern: '^备份', check: { type: 'path_exists', path: 'D:\\b' } }];
  assert.deepEqual(curatedFor('备份在 D:\\b', arrayForm), { type: 'path_exists', path: 'D:\\b' });

  const broken = { rules: [{ pattern: '([', check: { type: 'path_exists', path: 'D:\\b' } }] };
  assert.equal(curatedFor('我备份了', broken), null, '写错的正则要跳过，不能让整次审计崩掉');
});

test('规则命中后按 check 现场核验：文件在却断言已删除 → refuted', () => {
  const events = [assistant(1, 1, `我已经删除了 ${readme}。`)];
  const turns = groupTurns(events);
  const result = audit({
    turns,
    live: true,
    checks: { rules: [{ pattern: '删除了', check: { type: 'path_absent', path: readme } }] },
  });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].verdict, 'refuted');
  assert.equal(result.claims[0].checkSource, 'curated');
});

test('覆盖率：未取证清单逐条保留（不只是 5 条示例）', () => {
  const lines = Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 项已经改好了。`).join('');
  const turns = groupTurns([assistant(1, 1, lines)]);
  const result = audit({ turns });

  assert.equal(result.summary.coverage.unbacked, 7);
  assert.equal(result.summary.coverage.unbackedList.length, 7, '清单要收全，示例只留 5 条是展示用的');

  const text = renderUnbacked(result);
  assert.match(text, /没有 token 7 句/);
  assert.match(text, /第 7 项已经改好了/);
});
