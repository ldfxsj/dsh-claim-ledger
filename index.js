import { readFileSync } from 'node:fs';
import { createRecorder } from './src/auto.mjs';
import { badgeOf, createLive } from './src/live.mjs';
import { audit } from './src/ledger.mjs';
import { badgeSchemas, createBadgeDefinition } from './src/projection.mjs';
import { renderBadge, renderErrors, renderRecorded, renderTable, renderTrends, renderUnbacked } from './src/render.mjs';
import { resolveSession } from './src/resolve.mjs';
import { ledgerDir, noteError, readErrors, readSnapshot } from './src/store.mjs';
import { groupTurns, loadSession } from './src/session.mjs';
import { createTail } from './src/tail.mjs';
import { trends as trendReport } from './src/trends.mjs';

/**
 * 会话头里的 id 带 `session-` 前缀（台账文件名就是它），而命令行和日志里常写裸 uuid。
 * 两个方向都试，免得对着一个明明记过的会话报「0 条断言」。
 */
function ledgerIds(id) {
  const bare = String(id).replace(/^session-/, '');
  return [...new Set([String(id), `session-${bare}`, bare])];
}

/** Host half: one read-only tool + one passive recorder on `turn/end`. */
const DESCRIPTION = [
  'Audit the completion claims ("done", "installed", "deleted", "verified") of a session log against what its tool output actually showed, and against read-only live checks when asked.',
  'Each claim gets exactly one verdict: verified (its facts appear in earlier or same-turn tool output, or a live check passed), refuted (a live check contradicts it), or unverifiable (no mechanical evidence — not a failure).',
  'The plugin also audits every turn by itself when that turn ends and keeps the result under ~/.dsh/claim-ledger/; pass recorded:true to read what it recorded for this session without re-auditing.',
  'Claims about writing a file ("I rewrote X") are checked against the write/edit call arguments, the file existing, and the file still being clean UTF-8 (no BOM, no replacement characters); a file that exists but is corrupted counts as refuted.',
  'The output ends with a coverage line: how many completion sentences ("I finished X") this scope contains, and how many of them even had a fact token to check — a green table on its own does not mean everything you claimed was verified.',
  'Records only: it never edits the conversation, never blocks a turn, and its exit paths carry no gate.',
  'Use it before claiming a multi-step job is finished, or when the user asks whether an earlier statement still holds.',
].join(' ');

const PARAMETERS = {
  type: 'object',
  properties: {
    session: {
      type: 'string',
      description:
        'Session log path, session directory, or session id. Omit to audit the calling session (resolved from the current agent id).',
    },
    turns: {
      type: 'string',
      description: 'Comma-separated turn numbers to limit the audit, for example "2,3". Omit for every turn.',
    },
    live: {
      type: 'boolean',
      description:
        'Run executable checks where one is known (file existence/absence, file content, file health, npm registry version, read-only command whitelist). Default false: log evidence only.',
    },
    checks: {
      type: 'string',
      description: 'Path to a JSON file mapping an exact claim sentence to a check object, for claims the automatic shapes miss.',
    },
    recorded: {
      type: 'boolean',
      description:
        'Read the snapshot the plugin wrote itself when a turn ended (default false: audit now). Shows per-turn counts and the claims that were refuted, without touching the log again.',
    },
    trends: {
      type: 'boolean',
      description:
        'Read the recorded ledger across sessions instead of auditing: per-session totals, which turn each session first produced an unverifiable claim, and which claim types were never verified. Costs no log parse.',
    },
    errors: {
      type: 'boolean',
      description:
        'Show the recorder\'s own failures (errors.log tail) instead of auditing. Recording never throws into the session, so this is the only place those failures surface.',
    },
    unbacked: {
      type: 'boolean',
      description:
        'List the completion sentences that had no fact token at all, instead of the claim table. Those sentences are never audited — the badge percentage comes from here.',
    },
    limit: {
      type: 'number',
      description: 'How many error lines to show with errors:true. Default 20.',
    },
    badge: {
      type: 'boolean',
      description:
        'Return the raw badge numbers the client badge is built from (same numbers, plain JSON) instead of the table. Useful to check that the live ledger agrees with the last audit.',
    },
    stance: {
      type: 'string',
      enum: ['action', 'report'],
      description:
        'Only return claims of this stance: action = "what I did" (first person, or a completion verb), report = facts about the world. Omit for both; the badge always splits them.',
    },
  },
  additionalProperties: false,
};

/**
 * 配置 schema。`@deepseek-ai/schemastery` 是宿主提供的包，而这个插件是 junction
 * 进 profile 的——node 按真实路径解析，所以从 D:\deepseek\claim-ledger 里 import 不到它。
 * 因此带兜底：拿不到 schema 就不导出 Config（插件照常激活、工具照常注册），
 * 配置值一律按可选字段防御式读取。声明 schema 只是给面板与校验用，不是运行前提。
 *
 * 本机加了一条更硬的兜底：包已随插件装进 `./node_modules`，所以先试普通 specifier，
 * 再用 `createRequire` 解析成绝对文件 URL——宿主的加载器未必认裸 specifier，但认文件路径。
 */
async function loadSchema() {
  const attempts = [
    async () => (await import('@deepseek-ai/schemastery')).default,
    async () => {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const require = createRequire(import.meta.url);
      return (await import(pathToFileURL(require.resolve('@deepseek-ai/schemastery')).href)).default;
    },
  ];
  for (const attempt of attempts) {
    try {
      const schema = await attempt();
      if (schema && typeof schema.object === 'function') return schema;
    } catch {
      // 下一档
    }
  }
  return null;
}

const Schema = await loadSchema();

/** same 兜底 for zod：投影的 schema 需要它，拿不到就用手写形状（徽章照常工作）。 */
async function loadZod() {
  const attempts = [
    async () => import('zod'),
    async () => {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const require = createRequire(import.meta.url);
      return import(pathToFileURL(require.resolve('zod')).href);
    },
  ];
  for (const attempt of attempts) {
    try {
      const mod = await attempt();
      if (mod?.z && typeof mod.z.object === 'function') return mod.z;
    } catch {
      // 下一档
    }
  }
  return null;
}

const zod = await loadZod();

const CONFIG_DEFAULTS = Object.freeze({ enabled: true, dir: '', debounceMs: 250, live: 'local' });

export const Config = Schema
  ? Schema.object({
      enabled: Schema.boolean()
        .default(CONFIG_DEFAULTS.enabled)
        .description('每个回合结束时自动记账。关掉后只剩手动调用 claim_audit。'),
      dir: Schema.string()
        .default(CONFIG_DEFAULTS.dir)
        .description('台账目录。留空用 ~/.dsh/claim-ledger（尊重 DSH_HOME）。'),
      debounceMs: Schema.number()
        .default(CONFIG_DEFAULTS.debounceMs)
        .description('同一会话连续回合的合并窗口（毫秒）。'),
      live: Schema.string()
        .default(CONFIG_DEFAULTS.live)
        .description('自动核验档：local=只查本机文件；none=只用日志证据。'),
    })
  : undefined;

function readConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const dir = typeof raw.dir === 'string' && raw.dir.trim() ? raw.dir.trim() : undefined;
  const debounceMs =
    Number.isFinite(raw.debounceMs) && raw.debounceMs >= 0 ? raw.debounceMs : CONFIG_DEFAULTS.debounceMs;
  return {
    enabled: raw.enabled !== false,
    dir,
    debounceMs,
    live: raw.live === 'none' ? 'none' : 'local',
  };
}

function turnsFrom(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const list = value
    .split(',')
    .map((n) => Number(n.trim()))
    .filter(Number.isFinite);
  return list.length ? list : null;
}

function sessionIdOf(session) {
  return session?.header?.id ?? session?.id ?? session?.sessionId ?? null;
}

function turnOf(event) {
  const n = event?.data?.turn ?? event?.turn;
  return typeof n === 'number' ? n : null;
}

export const inject = ['tools'];

/**
 * 徽章的客户端那一半靠 `sessionProjections` 的 `wire`：宿主把 `view(state)`
 * 放进 client 快照，slot props 里用 `useProjection('claim-ledger')` 取。
 *
 * 这里用 `ctx.get` 可选取服务（投影缺席时徽章不显示，但工具照常注册），并且
 * 不去 await 注册：apply 保持同步，才能把 disposer 稳定交回给宿主；注册若晚
 * 一点完成，只是徽章晚一点出现。
 */
export function apply(ctx, config) {
  const cfg = readConfig(config);
  const dir = cfg.dir ?? ledgerDir();
  const tail = createTail();
  // 一份台账两处读：自动记账从它落盘，投影把它送进客户端徽章。
  const store = createLive({ live: cfg.live, maxSessions: 40 });
  const recorder = createRecorder({ dir, debounceMs: cfg.debounceMs, live: cfg.live, store });
  const { stateSchema, viewSchema } = badgeSchemas(zod);
  let badge = null;
  let badgeDisposed = false;
  const files = new Map(); // sessionId -> path | null
  const missingAt = new Map(); // sessionId -> 最近一次没找到日志的时间
  const RETRY_MS = 30_000;

  function logError(message) {
    noteError(message, { dir });
  }

  /**
   * 会话日志路径。插件在会话中途加载时，用日志补一遍历史事件，
   * 否则「证据在上一轮工具输出里」会被判成 unverifiable（这是同一类 bug 的第二个入口）。
   * 新会话在第一条事件时日志可能还没落盘，所以失败不记错误，30 秒后再试。
   */
  function fileOf(id, { retry = false } = {}) {
    if (files.get(id)) return files.get(id);
    // 负缓存只管「非回合结束」的查询：新会话的第一条事件往往早于日志落盘，
    // 但 turn/end 时日志一定已经写了，此时值得再试一次（并在此补上历史事件）。
    if (files.get(id) === null && !retry && Date.now() - (missingAt.get(id) ?? 0) < RETRY_MS) return null;

    try {
      const file = resolveSession(id);
      files.set(id, file);
      if (!tail.seeded(id)) tail.seed(id, loadSession(file).events);
      return file;
    } catch {
      files.set(id, null);
      missingAt.set(id, Date.now());
      return null;
    }
  }

  function onSessionEvent(session, event) {
    const id = sessionIdOf(session);
    if (!id || !event || typeof event.type !== 'string') return;

    const file = fileOf(id, { retry: event.type === 'turn/end' });
    tail.push(id, event);
    if (event.type !== 'turn/end') return;

    recorder.schedule({
      sessionId: id,
      file,
      turn: turnOf(event),
      turns: tail.turns(id),
    });
    // turns 数组已经把这一批回合握在手里了，内存里更早的分组结果可以丢掉。
    tail.trim(id);
  }

  let offSession = null;
  let offDisposed = null;
  if (cfg.enabled) {
    offSession = ctx.on('session/event', (session, event) => {
      try {
        onSessionEvent(session, event);
      } catch (error) {
        logError(`读取会话事件失败：${error?.message ?? error}`);
      }
    });

    // 会话结束时把内存里的尾巴与增量台账丢掉：这两样都只对活着的会话有意义。
    offDisposed = ctx.on('session/disposed', (session) => {
      try {
        const id = sessionIdOf(session);
        if (!id) return;
        tail.forget(id);
        recorder.forget(id);
        files.delete(id);
        missingAt.delete(id);
      } catch (error) {
        logError(`清理会话状态失败：${error?.message ?? error}`);
      }
    });
  }

  // 投影：客户端徽章的数据源。注册失败只记账，不影响工具。
  if (cfg.enabled) {
    try {
      const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : null;
      if (projections && typeof projections.register === 'function') {
        Promise.resolve(projections.register(createBadgeDefinition({ store, stateSchema, viewSchema })))
          .then((handle) => {
            badge = handle;
            // 注册还没回来就被卸载了：直接收掉，别把句柄漏在服务里
            if (badgeDisposed) handle?.dispose?.();
          })
          .catch((error) => logError(`注册徽章投影失败：${error?.message ?? error}`));
      }
    } catch (error) {
      logError(`注册徽章投影失败：${error?.message ?? error}`);
    }
  }

  const disposeTool = ctx.tools.register({
    name: 'claim_audit',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}, exec = {}) {
      const callerId = exec.agent?.id ?? null;

      if (args.trends === true) {
        return `${renderTrends(trendReport({ dir }))}`;
      }

      if (args.errors === true) {
        const { file, lines } = readErrors({ dir, limit: Number.isFinite(args.limit) ? args.limit : 20 });
        return renderErrors({ file, lines, ledgerDir: dir });
      }

      if (args.badge === true) {
        const id = (args.session ?? callerId ?? '').trim();
        if (!id) throw new Error('badge 需要会话：请给 session 参数（会话 id），或从会话内调用。');
        // 会话头里的 id 带 `session-` 前缀（台账文件名就是它），而用户/日志里常写裸 uuid。
        // 两个方向都试一遍，否则会对着一个明明记过的会话报「0 条断言」。
        let live = null;
        for (const candidate of ledgerIds(id)) {
          const one = store.badgeOf(candidate);
          if (one.turn > 0) {
            live = one;
            break;
          }
        }
        let source = `live 台账里记了 ${store.size} 个会话。`;
        if (!live) {
          let snapshot = null;
          for (const candidate of ledgerIds(id)) {
            snapshot = readSnapshot(candidate, { dir });
            if (snapshot) break;
          }
          if (snapshot && Array.isArray(snapshot.claims)) {
            live = badgeOf(
              { claims: snapshot.claims, summary: snapshot.summary },
              { id, turn: snapshot.turn ?? 0, updatedAt: Date.parse(snapshot.recordedAt ?? '') || 0 },
            );
            source = `live 台账里没有这个会话（插件重载后还没收到它的事件），这是落盘快照：${snapshot.file ?? id}`;
          } else {
            live = store.badgeOf(id);
          }
        }
        return ['badge（客户端徽章的数据源）', JSON.stringify(live, null, 2), source].join('\n');
      }

      if (args.recorded === true) {
        const id = (args.session ?? callerId ?? '').trim();
        if (!id) throw new Error('recorded 需要会话：请给 session 参数（会话 id），或从会话内调用。');
        let snapshot = null;
        for (const candidate of ledgerIds(id)) {
          snapshot = readSnapshot(candidate, { dir });
          if (snapshot) break;
        }
        if (!snapshot) {
          return [
            `还没有记账：会话 ${id} 没有落盘的回合快照。`,
            `自动记账在每个 turn/end 之后写入 ${dir}；插件是在回合进行中加载的，或这个会话还没结束过回合。`,
          ].join('\n');
        }
        return renderRecorded(snapshot) ?? `会话 ${id} 的快照为空。`;
      }

      const file = resolveSession(args.session ?? null, { agentId: callerId });
      const { events, skipped } = loadSession(file);
      const checks = args.checks ? JSON.parse(readFileSync(args.checks, 'utf8')) : {};
      const turns = groupTurns(events);
      const result = audit({
        turns,
        onlyTurns: turnsFrom(args.turns),
        checks,
        live: args.live === true,
        stance: args.stance === 'action' || args.stance === 'report' ? args.stance : null,
      });

      const head = renderTable(result);
      if (args.unbacked === true) {
        return `${renderUnbacked(result)}\nbadge: ${renderBadge(result.summary)}`;
      }
      const tailText = [
        `badge: ${renderBadge(result.summary)}`,
        `session: ${file}${skipped ? `（跳过 ${skipped} 行坏 JSON）` : ''}`,
        '没有可执行核验的 ? 不等于通过；纯链接、无动作词的句子不判定。',
      ].join('\n');
      return `${head}\n${tailText}`;
    },
  });

  return () => {
    badgeDisposed = true;
    badge?.dispose?.();
    recorder.dispose();
    store.dispose();
    offSession?.();
    offDisposed?.();
    disposeTool?.();
  };
}
