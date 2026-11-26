/**
 * 客户端徽章的投影定义。
 *
 * 为什么走投影而不是自己起 HTTP 路由：投影是宿主文档里给「Client 需要的派生值」
 * 的通道（`wire.view`），浏览器侧的 slot props 里就有 `useProjection`；而起一条
 * 本机 HTTP 路由等于给任何网页开一个无鉴权的读接口（市面上 548 个插件都是这么
 * 干的，我不要加一个）。
 *
 * 状态就是徽章本身（一个小 JSON），因为 apply 只在 turn/end 时换掉它；其余事件
 * 原样返回同一个引用，宿主的 Object.is 比较因此不会误报变化。
 */

import { emptyBadge } from './live.mjs'

export const BADGE_KEY = 'claim-ledger'
// v2：状态里多了 rows / hidden（完整面板要逐条看）。形状变了就必须换版本，
// 否则宿主会拿旧检查点去 parse 新形状。
export const BADGE_STATE_VERSION = 2

function isRow(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.turn === 'number' &&
    (value.stance === 'action' || value.stance === 'report') &&
    typeof value.kind === 'string' &&
    (value.verdict === 'verified' || value.verdict === 'refuted' || value.verdict === 'unverifiable') &&
    typeof value.quote === 'string' &&
    typeof value.note === 'string'
  )
}

function isBadge(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.turn === 'number' &&
    typeof value.claims === 'number' &&
    typeof value.verified === 'number' &&
    typeof value.refuted === 'number' &&
    typeof value.unverifiable === 'number' &&
    typeof value.actionTotal === 'number' &&
    typeof value.actionVerified === 'number' &&
    typeof value.actionRefuted === 'number' &&
    typeof value.actionUnverifiable === 'number' &&
    typeof value.completions === 'number' &&
    typeof value.covered === 'number' &&
    typeof value.pct === 'number' &&
    typeof value.unbacked === 'number' &&
    typeof value.updatedAt === 'number' &&
    Array.isArray(value.refutedQuotes) &&
    value.refutedQuotes.every(
      (one) => one && typeof one.quote === 'string' && typeof one.turn === 'number',
    ) &&
    Array.isArray(value.rows) &&
    value.rows.every(isRow) &&
    typeof value.hidden === 'number'
  )
}

/**
 * 手写的 schema 兜底。宿主只调用 `.parse()`（`stateSchema.parse(val)` 与
 * `wire.viewSchema.parse(view)`），所以这个形状足够；真实 zod 拿不到时用它，
 * 徽章不会因为少一个依赖就整块消失。
 */
export const plainBadgeSchema = {
  parse(value) {
    if (!isBadge(value)) throw new Error('claim-ledger 徽章形状不合法')
    return value
  },
  safeParse(value) {
    return isBadge(value) ? { success: true, data: value } : { success: false, error: new Error('bad badge') }
  },
}

/** 拿到 zod 就用 zod（宿主自己也是用 zod 的），拿不到用上面的兜底。 */
export function badgeSchemas(zod) {
  if (!zod) return { stateSchema: plainBadgeSchema, viewSchema: plainBadgeSchema }
  const quote = zod.object({ turn: zod.number(), quote: zod.string() })
  const row = zod.object({
    turn: zod.number().int().nonnegative(),
    stance: zod.enum(['action', 'report']),
    kind: zod.string(),
    verdict: zod.enum(['verified', 'refuted', 'unverifiable']),
    quote: zod.string(),
    note: zod.string(),
  })
  const shape = {
    id: zod.string(),
    turn: zod.number().int().nonnegative(),
    claims: zod.number().int().nonnegative(),
    verified: zod.number().int().nonnegative(),
    refuted: zod.number().int().nonnegative(),
    unverifiable: zod.number().int().nonnegative(),
    actionTotal: zod.number().int().nonnegative(),
    actionVerified: zod.number().int().nonnegative(),
    actionRefuted: zod.number().int().nonnegative(),
    actionUnverifiable: zod.number().int().nonnegative(),
    completions: zod.number().int().nonnegative(),
    covered: zod.number().int().nonnegative(),
    pct: zod.number().min(0).max(100),
    unbacked: zod.number().int().nonnegative(),
    refutedQuotes: zod.array(quote).max(5),
    rows: zod.array(row),
    hidden: zod.number().int().nonnegative(),
    updatedAt: zod.number(),
  }
  return { stateSchema: zod.object(shape), viewSchema: zod.object(shape) }
}

/**
 * @param {object} options
 * @param {ReturnType<import('./live.mjs').createLive>} options.store
 */
export function createBadgeDefinition({ store, stateSchema, viewSchema }) {
  return {
    key: BADGE_KEY,
    stateSchema,
    stateVersion: BADGE_STATE_VERSION,
    init(header) {
      return emptyBadge(header?.id ?? '')
    },
    apply(state, event) {
      const id = state?.id
      if (!id) return state
      store.ingest(id, event)
      const badge = store.badgeOf(id)
      // 只有真的进了新回合才换引用：别的引用变化会让宿主认为徽章变了
      return badge.turn !== state.turn ? badge : state
    },
    wire: {
      viewSchema,
      view(state) {
        return state
      },
    },
  }
}
