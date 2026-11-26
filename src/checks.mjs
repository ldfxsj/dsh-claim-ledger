import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * 核验器的封闭词表。断言文本本身永远不被执行——只有这里列出的形状能变成动作。
 * 返回值契约：
 *   { ok: true }   → verified
 *   { ok: false }  → refuted
 *   { crash }      → 核验没跑成，一律降级为 unverifiable，绝不记为推翻
 */
const WIN = process.platform === 'win32';
// 只放真正的可执行文件；npm 是 .cmd shim，Windows 下不能直接 spawn，版本查询走 registry API。
const BIN_ALLOW = new Set(['node', 'git', 'python', 'python3', 'curl']);

function exec(argv, timeoutMs = 15000) {
  const head = argv[0];
  const r = spawnSync(head, argv.slice(1), {
    timeout: timeoutMs,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return {
    status: r.status,
    error: r.error ? String(r.error.message ?? r.error) : null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

// 在子 Node 进程里查 registry，避免依赖 npm 的 .cmd shim 与 shell。
const REGISTRY_SCRIPT = [
  'const p = encodeURIComponent(process.argv[1]);',
  'fetch("https://registry.npmjs.org/" + p + "/latest", { signal: AbortSignal.timeout(15000) })',
  '  .then((r) => r.json())',
  '  .then((j) => { if (!j || !j.version) { process.stderr.write("no version field"); process.exit(1); } process.stdout.write(String(j.version)); })',
  '  .catch((e) => { process.stderr.write(String(e && e.message ? e.message : e)); process.exit(1); });',
].join('\n');

function tail(s, n = 160) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export const CHECKS = {
  path_exists({ path }) {
    return existsSync(path)
      ? { ok: true, detail: `存在：${path}` }
      : { ok: false, detail: `不存在：${path}` };
  },

  path_absent({ path }) {
    return existsSync(path)
      ? { ok: false, detail: `仍然存在：${path}` }
      : { ok: true, detail: `已不存在：${path}` };
  },

  file_contains({ path, pattern }) {
    if (!existsSync(path)) return { crash: `文件不存在，无法核验内容：${path}` };
    const text = readFileSync(path, 'utf8');
    let re;
    try {
      re = new RegExp(pattern, 'm');
    } catch (err) {
      return { crash: `正则无效：${String(err.message ?? err)}` };
    }
    return re.test(text)
      ? { ok: true, detail: `${path} 命中 /${pattern}/` }
      : { ok: false, detail: `${path} 未命中 /${pattern}/` };
  },

  /**
   * 文件健康度：严格 UTF-8、无 BOM、无替换字符（U+FFFD）。
   * 这是被真实事故逼出来的核验：用 shell 改中文文件时按 GBK 读、按 UTF-8 写，
   * 文件「存在」但内容已经坏了。`file_contains` 表达不了「不许有这种字符」。
   */
  file_clean({ path }) {
    if (!existsSync(path)) return { crash: `文件不存在，无法核验健康度：${path}` };
    const buf = readFileSync(path);
    const problems = [];
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push('有 UTF-8 BOM');
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      problems.push('不是合法 UTF-8');
      text = buf.toString('utf8');
    }
    const bad = (text.match(/\uFFFD/g) ?? []).length;
    if (bad) problems.push(`含 ${bad} 个替换字符 U+FFFD`);
    return problems.length
      ? { ok: false, detail: `${path} 内容不干净：${problems.join('、')}` }
      : { ok: true, detail: `${path} 是干净 UTF-8（无 BOM、无替换字符）` };
  },

  npm_version({ package: pkg, expect, timeoutMs }) {
    if (!pkg) return { crash: 'npm_version 缺少 package' };
    if (!/^[@a-zA-Z0-9._/-]+$/.test(pkg)) return { crash: `包名不合法：${pkg}` };
    const r = spawnSync(process.execPath, ['-e', REGISTRY_SCRIPT, pkg], {
      timeout: timeoutMs ?? 20000,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.error) return { crash: String(r.error.message ?? r.error) };
    const got = r.stdout.trim();
    if (r.status !== 0 || !got) return { crash: tail(r.stderr || 'registry 查询无输出') };
    return got === String(expect)
      ? { ok: true, detail: `${pkg} latest → ${got}` }
      : { ok: false, detail: `${pkg} latest → ${got}（断言说 ${expect}）` };
  },

  command({ argv, expectExit = 0, timeoutMs }) {
    if (!Array.isArray(argv) || !argv.length) return { crash: 'command 缺少 argv' };
    if (!BIN_ALLOW.has(argv[0])) return { crash: `拒绝执行：${argv[0]} 不在白名单内` };
    const r = exec(argv, timeoutMs ?? 15000);
    if (r.error) return { crash: r.error };
    const detail = `\`${argv.join(' ')}\` → exit ${r.status}${r.stdout ? ` · ${tail(r.stdout)}` : ''}`;
    return r.status === expectExit ? { ok: true, detail } : { ok: false, detail };
  },
};

export function runCheck(spec) {
  if (!spec || typeof spec.type !== 'string') return { crash: '核验描述缺少 type' };
  const fn = CHECKS[spec.type];
  if (!fn) return { crash: `未知核验类型：${spec.type}` };
  try {
    return fn(spec) ?? { crash: '核验器没有返回结果' };
  } catch (err) {
    return { crash: String(err?.message ?? err) };
  }
}

export function describeCheck(spec) {
  const { type, ...rest } = spec;
  const inner = Object.entries(rest)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(' ') : v}`)
    .join(' ');
  return `${type}(${inner})`;
}
