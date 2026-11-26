import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl'];

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions');
}

function isFile(p) {
  return existsSync(p) && statSync(p).isFile();
}

function isDir(p) {
  return existsSync(p) && statSync(p).isDirectory();
}

function logIn(dir) {
  for (const name of LOG_NAMES) {
    const p = join(dir, name);
    if (isFile(p)) return p;
  }
  return null;
}

/**
 * 把「路径 / 会话目录 / 会话 id」统一解析成会话日志文件。
 * 只读：不创建、不改写任何东西；找不到就抛错并列出找过的位置。
 */
export function resolveSession(input, { agentId = null, root = sessionsRoot() } = {}) {
  const target = (input ?? '').trim() || (agentId ?? '').trim();
  const tried = [];

  if (!target) {
    throw new Error('没有可审计的会话：请给 session 参数（会话日志路径或会话 id）。');
  }

  if (isFile(target)) return target;

  if (isDir(target)) {
    const found = logIn(target);
    if (found) return found;
    tried.push(join(target, LOG_NAMES[0]));
  }

  if (!isDir(root)) {
    throw new Error(`找不到 DSH 会话目录：${root}（可用 DSH_HOME 覆盖）`);
  }

  // 主会话目录叫 `session-<id>`，子代理会话目录直接叫 `<id>`——两种都要认。
  const dirNames = [...new Set([`session-${target}`, target, target.replace(/^session-/, '')])];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of dirNames) {
      const dir = join(root, entry.name, name);
      const found = isDir(dir) ? logIn(dir) : null;
      if (found) return found;
    }
    tried.push(join(root, entry.name, dirNames[0]));
  }

  const shown = tried.slice(0, 3).join('；');
  throw new Error(
    `找不到会话日志：${target}。在 ${root} 下找过 ${tried.length} 个位置${shown ? `（如 ${shown}）` : ''}。`,
  );
}
