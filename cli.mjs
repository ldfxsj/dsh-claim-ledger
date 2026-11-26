#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadSession, groupTurns } from './src/session.mjs';
import { audit } from './src/ledger.mjs';
import { renderTable, renderBadge, renderTrends } from './src/render.mjs';
import { trends } from './src/trends.mjs';

const USAGE = `断言台账 (claim ledger) v0.4.0

用法:
  node cli.mjs audit   <session.jsonl[.zstd]> [--turn 1,2] [--live[=local]] [--checks <file.json>] [--stance action|report] [--json]
  node cli.mjs extract <session.jsonl[.zstd]> [--turn 1,2] [--json]
  node cli.mjs trends  [--dir <台账目录>] [--json]

判定:
  ✓ verified      本轮工具输出包含该断言的全部事实；或现场核验通过
  ✗ refuted       现场核验与断言矛盾
  ? unverifiable  没有机械证据（不是失败）

选项:
  --live            运行可执行的核验（只读命令白名单：node/git/python/curl；npm_version 走 registry 查询）
  --live=local      只跑本机文件核验（路径存在/不存在、文件包含、文件健康度），不联网、不起进程
  --checks <f>      断言 → 核验动作的映射文件（按断言原文精确匹配）
  --stance <s>      只看 action（我做了什么）或 report（世界是什么样）
  --dir <d>         trends 读哪个台账目录（默认 ~/.dsh/claim-ledger）
  --fail-on-refuted 出现 refuted 时以退出码 2 结束（默认永远 0：台账不是门禁）
`;

function parseArgs(argv) {
  const out = { _: [], live: false, json: false, failOnRefuted: false, checks: null, turns: null, stance: null, dir: null, width: 110 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a.startsWith('--live=')) out.live = a.slice('--live='.length) === 'local' ? 'local' : true;
    else if (a === '--json') out.json = true;
    else if (a === '--fail-on-refuted') out.failOnRefuted = true;
    else if (a === '--checks') out.checks = argv[++i];
    else if (a === '--turn') out.turns = String(argv[++i]).split(',').map(Number).filter(Number.isFinite);
    else if (a === '--stance') out.stance = ['action', 'report'].includes(argv[i + 1]) ? argv[++i] : null;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--width') out.width = Number(argv[++i]) || out.width;
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [mode, file] = args._;

  if (mode === 'trends') {
    const report = trends(args.dir ? { dir: args.dir } : {});
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${renderTrends(report, { width: args.width })}\n`);
    return 0;
  }

  if (!mode || mode === '-h' || mode === '--help' || !file) {
    process.stdout.write(USAGE);
    return 0;
  }

  const { events, skipped } = loadSession(file);
  const turns = groupTurns(events);

  if (mode === 'extract') {
    const { claims } = audit({ turns, onlyTurns: args.turns });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(claims, null, 2)}\n`);
      return 0;
    }
    for (const c of claims) {
      process.stdout.write(`[t${c.turn}] ${c.quote}\n      tokens: ${c.tokens.join(' , ')}  id=${c.id}\n`);
    }
    process.stdout.write(`\n${claims.length} 条候选断言（turn ${args.turns ? args.turns.join(',') : '全部'}，跳过 ${skipped} 行坏 JSON）\n`);
    return 0;
  }

  if (mode !== 'audit') {
    process.stderr.write(`未知模式：${mode}\n\n${USAGE}`);
    return 1;
  }

  const checks = args.checks ? JSON.parse(readFileSync(args.checks, 'utf8')) : {};
  const result = audit({ turns, onlyTurns: args.turns, checks, live: args.live, stance: args.stance });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTable(result, { width: args.width })}\n`);
    process.stdout.write(`badge: ${renderBadge(result.summary)}\n`);
  }

  if (args.failOnRefuted && result.summary.refuted > 0) return 2;
  return 0;
}

process.exitCode = main();
