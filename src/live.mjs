/**
 * 会话级实时台账：一个会话一份增量台账，事件与回合两条入口共用。
 *
 * 为什么要有这一层：自动记账（turn/end 落盘）和投影（给客户端看的徽章）
 * 各自都需要「这个会话到目前为止的判定」。以前两边各算一遍，同一个会话会被
 * 审计两次，而且两边的结论有可能因为喂入顺序不同而不一致。这里把计算收成一份，
 * 谁先到谁算，另一个直接读结果。
 */

import { createGrouper } from './session.mjs'
import { createLedger } from './ledger.mjs'

/** 空徽章：还没记账时的形状，schema 与有数据时完全一致。 */
export function emptyBadge(id = '') {
  return {
    id,
    turn: 0,
    claims: 0,
    verified: 0,
    refuted: 0,
    unverifiable: 0,
    actionTotal: 0,
    actionVerified: 0,
    actionRefuted: 0,
    actionUnverifiable: 0,
    completions: 0,
    covered: 0,
    pct: 0,
    unbacked: 0,
    refutedQuotes: [],
    rows: [],
    hidden: 0,
    updatedAt: 0,
  }
}

const QUOTE_MAX = 120
const NOTE_MAX = 160

/**
 * 面板最多带多少条逐条记录。超过就只留最近的，前面的用 `hidden` 报数——
 * 一次会话可能几百条断言，全塞进客户端快照没人看得完，也不该这么大。
 */
export const PANEL_CAP = 300

function clip(text, max = QUOTE_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function compactRow(row) {
  return {
    turn: row.turn,
    stance: row.stance === 'action' ? 'action' : 'report',
    kind: row.kind ?? 'number',
    verdict: row.verdict,
    quote: clip(row.quote),
    note: row.note ? clip(row.note, NOTE_MAX) : '',
  }
}

/**
 * 把一次审计结果压成客户端要的形状。
 *
 * 徽章那一行只用几个数；面板要能逐条看，所以再带一份最近的记录（最多
 * PANEL_CAP 条，更早的用 hidden 报数）。两者共用同一份状态，不各算一遍。
 */
export function badgeOf(result, { id = '', turn = 0, updatedAt = Date.now() } = {}) {
  const summary = result?.summary ?? {}
  const rows = result?.claims ?? []
  const coverage = summary.coverage ?? {}
  const completions = coverage.completions ?? 0
  const covered = coverage.backed ?? 0
  const action = summary.byStance?.action ?? {}
  const refuted = rows.filter((row) => row.verdict === 'refuted')
  const recent = rows.slice(-PANEL_CAP)

  return {
    id,
    turn,
    claims: summary.total ?? 0,
    verified: summary.verified ?? 0,
    refuted: summary.refuted ?? 0,
    unverifiable: summary.unverifiable ?? 0,
    actionTotal: action.total ?? 0,
    actionVerified: action.verified ?? 0,
    actionRefuted: action.refuted ?? 0,
    actionUnverifiable: action.unverifiable ?? 0,
    completions,
    covered,
    pct: completions === 0 ? 0 : Math.round((covered / completions) * 100),
    unbacked: coverage.unbacked ?? 0,
    refutedQuotes: refuted.slice(-5).map((row) => ({ turn: row.turn, quote: clip(row.quote) })),
    rows: recent.map(compactRow),
    hidden: rows.length - recent.length,
    updatedAt,
  }
}

/**
 * @param {object} options
 * @param {false|'local'|true|'all'} [options.live] 与 audit() 同一档位
 * @param {object} [options.checks]
 * @param {number} [options.maxSessions] 内存里最多留几个会话的台账
 * @param {() => number} [options.now]
 */
export function createLive({ live = 'local', checks = {}, maxSessions = 40, now = () => Date.now() } = {}) {
  const sessions = new Map()
  const ledgerLive = live === 'none' ? false : live

  function evictIfNeeded() {
    if (sessions.size < maxSessions) return
    let oldestId = null
    let oldestAt = Infinity
    for (const [id, state] of sessions) {
      if (state.touched < oldestAt) {
        oldestAt = state.touched
        oldestId = id
      }
    }
    if (oldestId !== null) sessions.delete(oldestId)
  }

  function stateOf(id) {
    let state = sessions.get(id)
    if (state) {
      state.touched = now()
      return state
    }
    // 只有在真的要建新会话时才驱逐，读操作不应该改动别人
    evictIfNeeded()
    state = {
      id,
      grouper: createGrouper(),
      ledger: createLedger({ live: ledgerLive, checks }),
      seenSeq: new Set(),
      doneTurns: new Set(),
      badge: emptyBadge(id),
      touched: now(),
    }
    sessions.set(id, state)
    return state
  }

  function ingestTurn(id, turn) {
    const state = stateOf(id)
    if (!turn || typeof turn.turn !== 'number' || state.doneTurns.has(turn.turn)) {
      return { advanced: false, badge: state.badge }
    }
    state.ledger.ingest(turn)
    state.doneTurns.add(turn.turn)
    const result = state.ledger.result()
    state.badge = badgeOf(result, {
      id,
      turn: Math.max(state.badge.turn, turn.turn),
      updatedAt: now(),
    })
    return { advanced: true, badge: state.badge }
  }

  return {
    /** 喂一个已分组的回合（自动记账用这个入口）。 */
    ingestTurn,
    /** 喂一条会话事件（投影用这个入口；只关心 turn/end）。 */
    ingest(id, event) {
      if (!event || typeof event !== 'object') return { advanced: false, badge: emptyBadge(id) }
      const state = stateOf(id)
      if (typeof event.seq === 'number') {
        if (state.seenSeq.has(event.seq)) return { advanced: false, badge: state.badge }
        state.seenSeq.add(event.seq)
      }
      state.grouper.apply(event)
      if (event.type !== 'turn/end') return { advanced: false, badge: state.badge }
      const turn = event.data?.turn
      const grouped = state.grouper.turns().find((one) => one.turn === turn)
      if (!grouped) return { advanced: false, badge: state.badge }
      return ingestTurn(id, grouped)
    },
    /** 一批回合并发喂入（自动记账在 recordNow 里用）。 */
    ingestTurns(id, turns) {
      let advanced = false
      for (const turn of turns) {
        if (ingestTurn(id, turn).advanced) advanced = true
      }
      return { advanced, badge: stateOf(id).badge }
    },
    badgeOf(id) {
      const state = sessions.get(id)
      return state ? state.badge : emptyBadge(id)
    },
    resultOf(id) {
      const state = sessions.get(id)
      return state ? state.ledger.result() : { claims: [], summary: {} }
    },
    turnsOf(id) {
      const state = sessions.get(id)
      return state ? state.grouper.turns() : []
    },
    forget(id) {
      sessions.delete(id)
    },
    dispose() {
      sessions.clear()
    },
    get size() {
      return sessions.size
    },
  }
}
