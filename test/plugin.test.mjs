import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { resolveSession } from '../src/resolve.mjs';
import { loadSession } from '../src/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sample = join(here, '..', 'samples', 'demo-session.jsonl');

function mount(config) {
  const registered = [];
  const handlers = new Map();
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      },
    },
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
  };
  const dispose = apply(ctx, config);
  return { dispose, registered, handlers, tool: registered[0] };
}

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'claim-ledger-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    });
}

test('注册一个工具，并返回台账', async () => {
  const { dispose, registered, tool } = mount();
  assert.equal(typeof dispose, 'function', 'apply 必须把 disposer 交回去');
  assert.equal(registered.length, 1);
  assert.equal(tool.name, 'claim_audit');
  assert.equal(tool.parameters.additionalProperties, false);

  const out = await tool.execute({ session: sample }, { agent: { id: 'unrelated-id' } });
  assert.match(out, /claims 3/);
  assert.match(out, /badge: assertions 3/);
  assert.match(out, /不等于通过/, '边界提示必须随结果一起返回');
});

test('turns 参数限定回合', async () => {
  const { tool } = mount();
  const all = await tool.execute({ session: sample }, {});
  const hit = await tool.execute({ session: sample, turns: '1' }, {});
  const miss = await tool.execute({ session: sample, turns: '999' }, {});
  assert.match(all, /claims 3/);
  assert.match(hit, /claims 3/, '样例的三条断言都在 turn 1');
  assert.match(miss, /claims 0/, `不存在的回合应该清空，实际：${miss}`);
});

test('找不到会话时给出可操作的信息', async () => {
  const { tool } = mount();
  await assert.rejects(
    () => tool.execute({ session: 'definitely-not-a-session' }, {}),
    /找不到会话日志/,
  );
});

test('resolveSession 接受文件与目录', () => {
  assert.equal(resolveSession(sample), sample);

  const dir = mkdtempSync(join(tmpdir(), 'claim-ledger-'));
  try {
    copyFileSync(sample, join(dir, 'session.v4.jsonl'));
    assert.equal(resolveSession(dir), join(dir, 'session.v4.jsonl'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSession 认得子代理那种不带 session- 前缀的目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'claim-ledger-root-'));
  try {
    const dir = join(root, '--w--', '420d6628-b7c2-4942-bb86-6e3e944b99c2');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'session.v4.jsonl');
    writeFileSync(log, '', 'utf8');
    assert.equal(resolveSession('420d6628-b7c2-4942-bb86-6e3e944b99c2', { root }), log);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('turn/end 之后自动记账，recorded 能读回来', () =>
  withTempHome(async (home) => {
    const { handlers, tool } = mount();
    const listener = handlers.get('session/event');
    assert.equal(typeof listener, 'function', '插件必须挂上 session/event');

    const session = { header: { id: 'sid-1' } };
    for (const event of loadSession(sample).events) listener(session, event);

    await new Promise((r) => setTimeout(r, 400));

    const snapshot = JSON.parse(readFileSync(join(home, 'claim-ledger', 'sid-1.json'), 'utf8'));
    assert.equal(snapshot.sessionId, 'sid-1');
    assert.equal(snapshot.turn, 1);
    assert.equal(snapshot.summary.total, 3);

    const recorded = await tool.execute({ recorded: true }, { agent: { id: 'sid-1' } });
    assert.match(recorded, /记账 /);
    assert.match(recorded, /claims 3/);
    assert.match(recorded, /只跑本机文件核验/);
  }));

test('badge：live 台账空时退回落盘快照，不报假空', () =>
  withTempHome(async (home) => {
    const { handlers, tool } = mount();
    const listener = handlers.get('session/event');
    const session = { header: { id: 'sid-badge' } };
    for (const event of loadSession(sample).events) listener(session, event);
    await new Promise((r) => setTimeout(r, 400));

    // 重新 mount 一个实例：内存台账是新的（模拟插件重载），但快照还在盘上
    const fresh = mount();
    const out = await fresh.tool.execute({ badge: true, session: 'sid-badge' }, {});
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    assert.equal(json.turn, 1, '应该读回落盘快照的回合，而不是 0');
    assert.equal(json.claims, 3);
    assert.equal(json.rows.length, 3, '面板记录随快照一起回来');
    assert.match(out, /落盘快照/);

    // id 前缀两个方向都要能对上（会话头带 `session-`，命令行常写裸 uuid）
    const prefixed = await fresh.tool.execute({ badge: true, session: 'session-sid-badge' }, {});
    const json2 = JSON.parse(prefixed.slice(prefixed.indexOf('{'), prefixed.lastIndexOf('}') + 1));
    assert.equal(json2.claims, 3);
  }));

test('Config：enabled=false 时只留工具，不订阅会话事件', () => {
  const { dispose, registered, handlers } = mount({ enabled: false });
  assert.equal(registered.length, 1, '工具仍要注册：手动审计与关掉自动记账是两件事');
  assert.equal(handlers.has('session/event'), false, '关掉自动记账就不该再挂 session/event');
  assert.equal(handlers.has('session/disposed'), false);
  dispose();
});

test('Config：dir 决定台账写到哪里', () =>
  withTempHome(async (home) => {
    const custom = join(home, 'somewhere-else');
    const { handlers } = mount({ dir: custom, debounceMs: 1 });
    const onEvent = handlers.get('session/event');
    // 一个最小的 turn/end：没有 turns 也要能记账（会写成 0 条断言）
    onEvent({ header: { id: 'cfg-session' } }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(readFileSync(join(custom, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
  }));

test('errors：没有记录时明说没有', async () => {
  const { tool } = mount();
  const out = await tool.execute({ errors: true }, {});
  assert.match(out, /没有错误记录/);
});

test('bounds：记录器出错也不会把异常抛进会话', () => {
  const { handlers } = mount();
  const onEvent = handlers.get('session/event');
  assert.doesNotThrow(() => onEvent(null, null));
  assert.doesNotThrow(() => onEvent({ header: { id: 'x' } }, { type: 'turn/end' }));
});

test('recorded 在还没有快照时解释原因，而不是空表', () =>
  withTempHome(async () => {
    const { tool } = mount();
    const out = await tool.execute({ recorded: true }, { agent: { id: 'never-ended' } });
    assert.match(out, /还没有记账/);
    assert.match(out, /claim-ledger/);
  }));

test('会话事件里出错只写 errors.log，不打断会话', () =>
  withTempHome(async (home) => {
    const { handlers } = mount();
    const listener = handlers.get('session/event');
    listener({ header: { id: 'sid-bad' } }, { type: 'turn/end', seq: 1, data: { turn: 1 } });

    await new Promise((r) => setTimeout(r, 400));
    // 没有 turns 数据也不算崩：快照仍然写出来（空台账），不产生 errors.log
    const snapshot = JSON.parse(readFileSync(join(home, 'claim-ledger', 'sid-bad.json'), 'utf8'));
    assert.equal(snapshot.summary.total, 0);
  }));

test('回合结束时补上日志路径，并把插件加载前的历史事件并进来', () =>
  withTempHome(async (home) => {
    const { handlers } = mount();
    const listener = handlers.get('session/event');
    const session = { header: { id: 'late-log' } };

    // 第一条事件到来时日志还没落盘
    listener(session, {
      type: 'assistant/message',
      seq: 3,
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '`x` 的版本是 1.2.3。' }] } },
    });

    // 日志此时才出现，里面已经有工具输出（断言唯一的合法证据来源）
    const logDir = join(home, 'sessions', '--w--', 'session-late-log');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, 'session.v4.jsonl'),
      [
        '{"type":"tool/call","seq":1,"data":{"turn":1,"step":1,"callId":"c1","name":"pwsh"}}',
        '{"type":"tool/result","seq":2,"data":{"turn":1,"step":1,"toolCallId":"c1","message":{"content":[{"type":"text","text":"x -> 1.2.3"}]}}}',
        '{"type":"assistant/message","seq":3,"data":{"turn":1,"step":2,"message":{"content":[{"type":"text","text":"`x` 的版本是 1.2.3。"}]}}}',
        '{"type":"turn/end","seq":4,"data":{"turn":1,"reason":{"kind":"completed"}}}',
        '',
      ].join('\n'),
      'utf8',
    );

    listener(session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } });
    await new Promise((r) => setTimeout(r, 400));

    const snapshot = JSON.parse(readFileSync(join(home, 'claim-ledger', 'late-log.json'), 'utf8'));
    assert.ok(snapshot.file?.endsWith('session.v4.jsonl'), `快照要记下日志路径，实际：${snapshot.file}`);
    assert.equal(snapshot.summary.total, 1);
    assert.equal(snapshot.summary.verified, 1, '补进来的工具输出应让断言变成 verified');
  }));
