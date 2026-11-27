import { createHash } from 'node:crypto';

/**
 * 抽取策略：只留下**带具体事实 token** 的句子（版本号 / 绝对路径 / 三位以上数字）。
 * 这是刻意的取舍——宁可漏，不要脏。模糊的“已完成”“弄好了”不产生断言，
 * 也就不会在台账里被一个假的“已验证”洗白。
 */
const TOKEN_RES = [
  { kind: 'version', re: /\b\d+\.\d+\.\d+\b/g },
  // 路径里排除 <>|() 等，避免把 markdown 的 <D:\a\b.docx> 连尖括号一起吃进 token
  { kind: 'path', re: /[A-Za-z]:\\[^\s`'"()<>|（）【】，。；、]+/g },
  { kind: 'number', re: /\b\d[\d,]{2,}\b/g },
];

const TRAIL = /[>)\]）】"'`,，。；;：:]+$/;

// `D:\…docx`、`D:\a\...` —— 省略号截断的路径不是路径，永远核不了。
// 实测它会被当成真路径去探一次存在性，然后得出「本机没有这个路径」，纯属误导。
const ELIDED = /…|\.{3}/;

function trimToken(value) {
  return value.replace(/^[<(（【"'`]+/, '').replace(TRAIL, '');
}

export function sentencesOf(text) {
  // 代码块里的内容是命令/配置，不是断言
  const plain = text.replace(/```[\s\S]*?```/g, '\n');
  const out = [];
  for (const rawLine of plain.split('\n')) {
    const line = rawLine
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)/, '')
      .trim();
    if (!line) continue;
    for (const part of line.split(/(?<=[。！？；!?;])/)) {
      const s = part.trim();
      if (s.length >= 8) out.push(s);
    }
  }
  return out;
}

export function tokensOf(sentence) {
  const found = [];
  for (const { kind, re } of TOKEN_RES) {
    for (const m of sentence.matchAll(re)) {
      const value = trimToken(m[0]);
      if (!value) continue;
      if (found.some((f) => f.value === value)) continue;
      found.push(ELIDED.test(value) ? { kind, value, elided: true } : { kind, value });
    }
  }
  return found;
}

export function claimId(quote) {
  return createHash('sha1').update(quote).digest('hex').slice(0, 10);
}

/**
 * 立场：`action` = 在说「我做了什么」，`report` = 在说「世界是什么样」。
 * 只用来分组，不参与判定——两种都会去核，但徽章要先把「我干完了」和「这个插件有 45 项成就」分开，
 * 否则一堆带数字的介绍会把行动类盖过去，37 条全绿看着很漂亮，其实没几条是我干的活。
 */
const ACTION_RES = [
  // 第一人称就是自述：这句话在讲“我做了什么”，不在讲世界是什么样。
  /我/,
  /(?:装|删|创建|写|改|跑|提交|合并|导出|生成|修|清理|补)(?:好|完)了/,
  /跑通了|通过了|完成了|搞定了|修好了|已经完成/,
  /已(?:完成|安装|删除|创建|写入|落盘|保存|通过|提交|合并|导出|生成|修好|清理)/,
];

export function stanceOf(sentence) {
  return ACTION_RES.some((re) => re.test(unquoted(sentence))) ? 'action' : 'report';
}

/**
 * 引号里的是「引用别人的话」，不是这句的主语。
 * 一条**转述**「我装不了」的句子，不该因为引号里有个「我」就被当成我的行动。
 */
const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|`[^`]*`/g;

export function unquoted(sentence) {
  return sentence.replace(QUOTED, ' ');
}

/**
 * 覆盖率的分子与分母：**这一回合到底有多少句「我把它做完了」，其中多少句有 token 可查。**
 * 台账只会记录带 token 的句子，所以「我更新了 README」这种没有任何路径/版本号的完成式断言
 * 根本不进表——徽章上 40 条全绿，也可能漏掉了另外 200 句「我干完了」。
 */
const DONE_RE =
  /(?:已|已经)(?:把|将|给)?[^。；，]{0,16}?(?:写|改|装|修|删|创建|导出|生成|跑|提交|合并|补充|清理|保存|落盘|通过|完成|更新)(?!的)|(?:写|改|装|修|删|创建|导出|生成|跑|提交|合并|补充|清理|保存|更新)(?:好|完|掉|上)了|跑通了|搞定了|完成了|通过了|装上了|修好了/;

/** 「跑通了再谈扩展」是计划不是事实；覆盖率不该把条件句算成完成性断言。 */
const PLAN_RE =
  /如果|假如|要是|再谈|准备|打算|待|以后|下次|明天|下周|需要|应该|可以|建议|要不要|是否|计划|能不能|能否|例如|比如|所谓|意思是|这类|(?:通过|完成|跑通|搞定|写好|做完)(?:之后|后)/;

/** 「已装的 X」「作者自己迁移了」不是我在报功——第三人称主语与定语都不算。 */
const OTHER_SUBJECT_RE = /作者|他们|她们|别人|用户|你/;

/**
 * 「跑通了 / 通过了 / 全绿」这类断言没有路径也没有版本号，以前根本进不了表：
 * 它们没有 token，覆盖率只记成「测不到」。但这类句子其实有机械把手——
 * 同一回合的**工具输出**里有没有成功标志（`10 passed`、`0 failed`、`全绿`…）。
 * 只匹配「测试/验证/构建 + 通过/成功」这种组合，以及句末的「跑通了 / 通过了」，
 * 免得把「通过调用工具」里的「通过」当成断言。
 */
export const RUN_RE =
  /(?:测试|验证|验收|编译|构建|CI|单测|用例|回归|检查)[^。；，]{0,10}?(?:通过|跑通|全绿|成功)|(?:跑通|通过|测过|验过|全绿)了/;

export function looksLikeRun(sentence) {
  return RUN_RE.test(unquoted(sentence));
}


export function doneSentences(text) {
  return sentencesOf(text).filter((sentence) => {
    const plain = unquoted(sentence);
    return DONE_RE.test(plain) && !PLAN_RE.test(plain) && !OTHER_SUBJECT_RE.test(plain);
  });
}

export function extractClaims(turn) {
  const claims = [];
  const seen = new Set();

  for (const ev of turn.assistant) {
    for (const block of ev.data?.message?.content ?? []) {
      if (block.type !== 'text') continue;
      for (const sentence of sentencesOf(block.text)) {
        const tokens = tokensOf(sentence);
        const run = looksLikeRun(sentence);
        // 没有 token 的「跑通了」只有在像行动自述时才收：它靠同回合输出里的成功标志取证。
        // 「跑通了再谈扩展」这类条件句不是事实，不收。
        const runnable = !tokens.length && run && !PLAN_RE.test(unquoted(sentence)) && stanceOf(sentence) === 'action';
        if (!tokens.length && !runnable) continue;
        if (seen.has(sentence)) continue;
        seen.add(sentence);
        claims.push({
          id: claimId(sentence),
          turn: turn.turn,
          step: ev.data?.step ?? null,
          quote: sentence,
          tokens,
          kind: tokens[0]?.kind ?? 'run',
          stance: stanceOf(sentence),
          run,
          runnable,
        });
      }
    }
  }

  return claims;
}
