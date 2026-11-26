import test from 'node:test';
import assert from 'node:assert/strict';
import { createLive } from '../src/live.mjs';
import {
  BADGE_KEY,
  BADGE_STATE_VERSION,
  badgeSchemas,
  createBadgeDefinition,
  plainBadgeSchema,
} from '../src/projection.mjs';

/** 一个完整回合的原始事件流（和会话日志里的形状一致）。 */
function turnEvents(turn, quote, toolText) {
  const base = turn * 10;
  return [
    { seq: base + 1, type: 'turn/start', data: { turn } },
    { seq: base + 2, type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: quote }] } } },
    { seq: base + 3, type: 'tool/call', data: { turn, step: 1, callId: `c${turn}`, name: 'pwsh', arguments: JSON.stringify({ command: 'echo hi' }) } },
    { seq: base + 4, type: 'tool/result', data: { turn, step: 1, toolCallId: `c${turn}`, message: { content: [{ type: 'text', text: toolText }] } } },
    { seq: base + 5, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ];
}

function fold(definition, events) {
  let state = definition.init({ id: 's1' });
  const seen = [];
  for (const event of events) {
    const next = definition.apply(state, event);
    seen.push(next === state);
    state = next;
  }
  return { state, sameReference: seen };
}

test('投影定义：key 与 stateVersion 固定，init 给出空徽章', () => {
  const store = createLive({ live: false });
  try {
    const { stateSchema, viewSchema } = badgeSchemas(null);
    const definition = createBadgeDefinition({ store, stateSchema, viewSchema });
    assert.equal(definition.key, BADGE_KEY);
    assert.equal(definition.key, 'claim-ledger');
    assert.equal(definition.stateVersion, BADGE_STATE_VERSION);
    const empty = definition.init({ id: 'abc' });
    assert.equal(empty.id, 'abc');
    assert.equal(empty.turn, 0);
    assert.equal(empty.claims, 0);
    assert.deepEqual(empty.refutedQuotes, []);
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.hidden, 0);
  } finally {
    store.dispose();
  }
});

test('投影 apply：只有回合结束才换引用，徽章随证据更新', () => {
  const store = createLive({ live: false });
  try {
    const { stateSchema, viewSchema } = badgeSchemas(null);
    const definition = createBadgeDefinition({ store, stateSchema, viewSchema });
    const events = turnEvents(1, '演示 0.4.0 已跑通。', 'compiled version 0.4.0');
    const { state, sameReference } = fold(definition, events);

    // 前四条（turn/start … tool/result）不改徽章对象，只有 turn/end 换一次
    assert.deepEqual(sameReference, [true, true, true, true, false]);
    assert.equal(state.turn, 1);
    assert.equal(state.claims, 1);
    assert.equal(state.verified, 1, '工具输出里有 0.4.0，断言应被证实');
    assert.equal(state.refuted, 0);
    assert.equal(state.id, 's1');
    assert.equal(definition.wire.view(state), state, 'view 直接返回状态，不做二次加工');

    // 面板要逐条看：一条断言对应一条精简记录
    assert.equal(state.rows.length, 1);
    assert.deepEqual(Object.keys(state.rows[0]).sort(), ['kind', 'note', 'quote', 'stance', 'turn', 'verdict']);
    assert.equal(state.rows[0].verdict, 'verified');
    assert.equal(state.rows[0].turn, 1);
    assert.equal(state.hidden, 0);

    // 同一回合再来一条事件，引用不变（宿主不会误判为更新）
    const again = definition.apply(state, { seq: 999, type: 'session/note', data: {} });
    assert.equal(again, state);
  } finally {
    store.dispose();
  }
});

test('面板记录有上限：超出的只报数，不塞进快照', async () => {
  const { PANEL_CAP, badgeOf } = await import('../src/live.mjs');
  const total = PANEL_CAP + 5;
  const claims = Array.from({ length: total }, (_, index) => ({
    turn: index + 1,
    stance: 'report',
    kind: 'number',
    verdict: 'verified',
    quote: `第 ${index + 1} 条断言。`,
    note: '',
  }));
  const badge = badgeOf({ claims, summary: { total, verified: total, refuted: 0, unverifiable: 0 } });
  assert.equal(badge.claims, total);
  assert.equal(badge.rows.length, PANEL_CAP);
  assert.equal(badge.hidden, total - PANEL_CAP);
  // 保留的是最近的：最后一条记录必须是第 total 条
  assert.equal(badge.rows[badge.rows.length - 1].turn, total);
  assert.equal(badge.rows[0].turn, total - PANEL_CAP + 1);
  plainBadgeSchema.parse(badge);
});

test('投影 schema：手写兜底能挡住坏形状，zod 版也能 parse', async () => {
  const bad = { id: 'x' };
  assert.throws(() => plainBadgeSchema.parse(bad), /形状不合法/);
  assert.equal(plainBadgeSchema.safeParse(bad).success, false);

  const store = createLive({ live: false });
  try {
    const good = store.badgeOf('demo');
    assert.equal(plainBadgeSchema.parse(good), good);

    let zod = null;
    try {
      zod = (await import('zod')).z ?? null;
    } catch {
      zod = null;
    }
    const schemas = badgeSchemas(zod);
    assert.equal(schemas.stateSchema.parse(good).id, 'demo');
    assert.equal(schemas.viewSchema.parse(good).turn, 0);
    if (zod) assert.throws(() => schemas.stateSchema.parse({ ...good, pct: 200 }));
  } finally {
    store.dispose();
  }
});
