import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

// zstd 帧的 magic 是字节 28 b5 2f fd，按小端读出来是 0xfd2fb528。
const ZSTD_MAGIC = 0xfd2fb528;

/** DSH 每追加一批事件就写一个 zstd 帧，日志是**多帧拼接**的（本机会话实测 682 帧）。 */
export function frameOffsets(buf) {
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i);
  }
  return offsets;
}

/**
 * 解压整个日志。有的运行时（Electron 自带的 node）只解第一帧，
 * 而第一帧往往只有一行 `session` 头——于是会「读到日志但里面没有事件」。
 * 所以先按 magic 切帧逐帧解；任何一帧解不开就退回整段解。
 */
export function decodeZstd(buf) {
  const offsets = frameOffsets(buf);
  if (offsets.length > 1) {
    try {
      const parts = [];
      for (let k = 0; k < offsets.length; k += 1) {
        const start = offsets[k];
        const end = offsets[k + 1] ?? buf.length;
        parts.push(zstdDecompressSync(buf.subarray(start, end)));
      }
      return Buffer.concat(parts);
    } catch {
      // 切错了（magic 出现在压缩数据内部）：交给运行时的整段解
    }
  }
  return zstdDecompressSync(buf);
}

/**
 * 读会话日志（.jsonl 或 .jsonl.zstd），按 seq 排序返回事件。
 * DSH 的会话文件是唯一可信来源（practices: session log is the only source of truth）。
 */
export function loadSession(file) {
  const buf = readFileSync(file);
  const text = (file.endsWith('.zstd') ? decodeZstd(buf) : buf).toString('utf8');
  const events = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      skipped += 1;
    }
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return { events, skipped };
}

/**
 * 按 turn 归并：assistant 文本 + 本轮全部工具输出（含来源工具名）。
 * 工具输出是断言唯一合法的证据来源：只有工具看到过的事实才算“有证据”。
 */
/**
 * 工具调用的入参文本。有两个坑：
 *   1. 日志里的 `arguments` 是**字符串**（已 JSON 编码过一次），直接 stringify 会变成双层转义；
 *   2. JSON 里反斜杠是 `\\`，工具输出里是 `\`，不归一化就永远匹配不上。
 * 这是「第二证据通道」：写文件类断言的路径只在入参里。
 */
export function argsText(args) {
  if (args == null) return '';
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // 不是 JSON 的字符串就按原样用
    }
  }
  try {
    return JSON.stringify(value).replace(/\\\\/g, '\\');
  } catch {
    return String(value);
  }
}

/**
 * 增量归并：事件的追加是一条一条来的（session/event），没必要每来一条就把整段历史重扫一遍。
 * 语义与 groupTurns(events) 完全相同——都要求事件按 seq 顺序喂入（日志与实时事件都满足）。
 */
export function createGrouper() {
  const callNames = new Map();
  const callArgs = new Map();
  const byTurn = new Map();
  let dirty = true;
  let cached = [];

  // callId → 名字/入参 只是查表用的旁路缓存；长会话里它也会一直涨，所以有个软上限。
  const MAX_CALLS = 4000;

  function ensure(n) {
    if (!byTurn.has(n)) {
      byTurn.set(n, { turn: n, assistant: [], tools: [], calls: [], ended: false, endReason: null });
    }
    return byTurn.get(n);
  }

  function rememberCall(callId, name, args) {
    callNames.set(callId, name);
    callArgs.set(callId, args);
    if (callNames.size > MAX_CALLS) {
      const oldest = callNames.keys().next().value;
      callNames.delete(oldest);
      callArgs.delete(oldest);
    }
  }

  function apply(e) {
    if (!e || typeof e.type !== 'string') return;
    const n = e.data?.turn;
    if (typeof n !== 'number') return;
    const rec = ensure(n);
    dirty = true;

    if (e.type === 'assistant/message') {
      rec.assistant.push(e);
      return;
    }
    if (e.type === 'tool/call') {
      const callId = e.data.callId ?? null;
      const name = e.data.name ?? 'unknown';
      const args = argsText(e.data.arguments);
      if (callId) rememberCall(callId, name, args);
      rec.calls.push({ callId, name, argsText: args });
      return;
    }
    if (e.type === 'tool/result') {
      const callId = e.data.toolCallId ?? e.data.message?.source?.callId ?? null;
      const text = (e.data.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      rec.tools.push({ callId, name: callNames.get(callId) ?? 'unknown', text });
      return;
    }
    if (e.type === 'turn/end') {
      rec.ended = true;
      rec.endReason = e.data.reason?.kind ?? null;
    }
  }

  return {
    apply,
    turns() {
      if (dirty) {
        cached = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
        dirty = false;
      }
      return cached;
    },
    /**
     * 丢掉 ≤ turn 的回合。只在「这些回合已经交给下游处理」之后调用——
     * 长会话里 byTurn 会把每一轮的原文都留在内存里，没有上限就是泄漏。
     */
    dropThrough(turn) {
      if (typeof turn !== 'number') return 0;
      let dropped = 0;
      for (const key of byTurn.keys()) {
        if (key <= turn) {
          byTurn.delete(key);
          dropped += 1;
        }
      }
      if (dropped) dirty = true;
      return dropped;
    },
  };
}

export function groupTurns(events) {
  const grouper = createGrouper();
  for (const e of events) grouper.apply(e);
  return grouper.turns();
}
