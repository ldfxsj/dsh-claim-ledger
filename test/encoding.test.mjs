import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 这条测试是事故的产物：用 PowerShell 的 Get-Content|Set-Content 改带中文的文件，
 * 会按系统代码页（GBK）读、按 UTF-8 写，结果文件「存在、能跑」，但内容已经变成乱码。
 * 项目里所有文本文件必须同时满足：合法 UTF-8、无 BOM、无替换字符。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp-smoke']);
const EXT = /\.(mjs|js|json|jsonl|md|yml)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXT.test(entry.name)) out.push(full);
  }
  return out;
}

test('项目自身的文本文件都是干净 UTF-8（无 BOM、无替换字符）', () => {
  const files = walk(ROOT);
  assert.ok(files.length > 10, '扫描到的文件太少，walk 可能出错了');

  const broken = [];
  for (const file of files) {
    const buf = readFileSync(file);
    const rel = relative(ROOT, file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      broken.push(`${rel}: 有 UTF-8 BOM`);
      continue;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      broken.push(`${rel}: 不是合法 UTF-8（多半是被按 GBK 读再按 UTF-8 写回）`);
      continue;
    }
    const bad = (text.match(/\uFFFD/g) ?? []).length;
    if (bad) broken.push(`${rel}: 含 ${bad} 个替换字符 U+FFFD`);
  }

  assert.deepEqual(broken, []);
});

test('file_clean 核验器能认出 BOM 与替换字符', async () => {
  const { runCheck } = await import('../src/checks.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const dir = mkdtempSync(join(tmpdir(), 'ledger-clean-'));
  const good = join(dir, 'good.md');
  writeFileSync(good, '标题\n内容正常。\n');
  assert.equal(runCheck({ type: 'file_clean', path: good }).ok, true);

  const bom = join(dir, 'bom.md');
  writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题\n', 'utf8')]));
  const r1 = runCheck({ type: 'file_clean', path: bom });
  assert.equal(r1.ok, false);
  assert.match(r1.detail, /BOM/);

  const bad = join(dir, 'bad.md');
  writeFileSync(bad, '标题 \uFFFD 坏了\n');
  const r2 = runCheck({ type: 'file_clean', path: bad });
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /替换字符/);

  assert.ok(runCheck({ type: 'file_clean', path: join(dir, 'nope.md') }).crash, '文件不在时是 crash，不是 refuted');
});
