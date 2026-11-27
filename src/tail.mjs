import { createGrouper } from './session.mjs';

/**
 * 每个会话的事件尾巴。用内存里的事件而不是每回合重读日志：
 * 日志是多帧 zstd、上千行，turn/end 又发生在 emit 快照里，重读既慢又有竞态。
 * 插件加载前就存在的历史事件由 `seed()` 一次性补进来（见 index.js 的 fileOf）。
 *
 * 归并也是增量的：每来一条事件只更新它所在的那个回合，取回合时只做一次排序。
 * 以前每次 turn/end 都对整段历史重新 groupTurns，长会话上是 O(回合²)。
 */
export function createTail() {
  const sessions = new Map();

  /**
   * 原始事件数组只是「还没分组前的暂存」，分组后的回合才是下游要的东西，
   * 所以它不需要留全程：长会话里每轮原文都在这里再存一遍，等于双份内存。
   */
  const MAX_EVENTS = 1000;
  /** 交给下游之后，更早的回合就可以从内存里丢掉（台账本身已经记住它们）。 */
  const MAX_TURNS = 400;

  function state(id) {
    let s = sessions.get(id);
    if (!s) {
      s = { events: [], seqs: new Set(), seeded: false, grouper: createGrouper() };
      sessions.set(id, s);
    }
    return s;
  }

  function add(s, event) {
    if (!event || typeof event.type !== 'string') return;
    const seq = typeof event.seq === 'number' ? event.seq : null;
    if (seq !== null) {
      if (s.seqs.has(seq)) return;
      s.seqs.add(seq);
    }
    s.events.push(event);
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    s.grouper.apply(event);
  }

  return {
    /** 补历史：可重复调用，按 seq 去重。 */
    seed(id, events) {
      const s = state(id);
      for (const e of events ?? []) add(s, e);
      s.seeded = true;
    },
    seeded(id) {
      return state(id).seeded;
    },
    push(id, event) {
      add(state(id), event);
    },
    events(id) {
      return state(id).events;
    },
    turns(id) {
      return state(id).grouper.turns();
    },
    size(id) {
      return state(id).events.length;
    },
    /**
     * 丢掉早于最近 keepTurns 个回合的分组结果。
     * 只在「这些回合已经作为数组交给记账/投影」之后调用——调用方手里那份数组仍然完整。
     */
    trim(id, keepTurns = MAX_TURNS) {
      const s = sessions.get(id);
      if (!s) return 0;
      const turns = s.grouper.turns();
      if (turns.length <= keepTurns) return 0;
      const through = turns[turns.length - keepTurns - 1].turn;
      return s.grouper.dropThrough(through);
    },
    forget(id) {
      sessions.delete(id);
    },
    ids() {
      return [...sessions.keys()];
    },
  };
}
