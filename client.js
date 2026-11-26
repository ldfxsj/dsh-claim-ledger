/**
 * 客户端那一半：输入框下面的徽章 + 点开后的完整面板。
 *
 * 数据来自宿主投影 `claim-ledger`（见 src/projection.mjs）：它的 `wire.view`
 * 会随 client 快照送到这里，slot props 的 `useProjection(key)` 取到徽章对象。
 * 这里不读文件、不发请求——徽章与面板都只是显示面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-claim-ledger',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace',
      fontSize: 11,
      lineHeight: '16px',
      fontVariantNumeric: 'tabular-nums',
    };

    const tone = {
      verified: 'var(--dsw-alias-state-success-primary)',
      refuted: 'var(--dsw-alias-state-error-primary)',
      unknown: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    const MARK = { verified: '✓', refuted: '✗', unverifiable: '?' };
    const MARK_TONE = { verified: tone.verified, refuted: tone.refuted, unverifiable: tone.unknown };

    const FILTERS = [
      { key: 'all', label: '全部' },
      { key: 'action', label: '行动' },
      { key: 'report', label: '陈述' },
      { key: 'refuted', label: '✗被推翻' },
      { key: 'unknown', label: '?测不到' },
    ];

    function counts(badge) {
      return [
        { key: 'verified', label: '✓', value: badge.verified, color: tone.verified, title: '有可执行证据' },
        { key: 'refuted', label: '✗', value: badge.refuted, color: tone.refuted, title: '被证据推翻' },
        { key: 'unverifiable', label: '?', value: badge.unverifiable, color: tone.unknown, title: '没有可执行核验（不等于通过）' },
      ];
    }

    function Count({ item }) {
      return h(
        'span',
        {
          title: item.title,
          style: { color: item.value > 0 ? item.color : tone.idle, ...mono, marginLeft: 6 },
        },
        `${item.label}${item.value}`,
      );
    }

    function Line({ badge, open, onToggle }) {
      const numbers = counts(badge);
      return h(
        'button',
        {
          type: 'button',
          onClick: onToggle,
          title: '断言台账：点开逐条看',
          'aria-expanded': open ? 'true' : 'false',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            maxWidth: '100%',
            padding: '1px 8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 999,
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            ...mono,
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, `台账 ${badge.claims}`),
        ...numbers.map((item) => h(Count, { key: item.key, item })),
        h('span', { style: { marginLeft: 8, color: tone.idle } }, `行动 ${badge.actionTotal}`),
        h(
          'span',
          { style: { marginLeft: 8, color: tone.idle }, title: '有事实 token、可以机械核验的比例' },
          `覆盖 ${badge.pct}%`,
        ),
        h('span', { style: { marginLeft: 6, color: tone.idle } }, open ? '▴' : '▾'),
      );
    }

    function SummaryRow({ label, value, color }) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 16, ...mono } },
        h('span', { style: { color: tone.idle } }, label),
        h('span', { style: { color: color ?? 'var(--dsw-alias-label-primary)' } }, value),
      );
    }

    function ClaimRow({ row }) {
      const stanceLabel = row.stance === 'action' ? '行动' : '陈述';
      const stanceTone = row.stance === 'action' ? tone.brand : tone.idle;
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: '38px 26px 1fr',
            gap: 6,
            padding: '3px 0',
            borderTop: '1px solid var(--dsw-alias-border-l2)',
          },
        },
        h(
          'span',
          { style: { ...mono, color: tone.idle } },
          `t${row.turn}`,
          h('span', { style: { marginLeft: 4, color: stanceTone } }, stanceLabel),
        ),
        h(
          'span',
          { style: { ...mono, color: MARK_TONE[row.verdict], textAlign: 'center' }, title: row.verdict },
          MARK[row.verdict],
        ),
        h(
          'span',
          { style: { ...mono, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' } },
          row.quote,
          row.note
            ? h(
                'span',
                { style: { display: 'block', color: tone.idle, marginTop: 1 } },
                row.note,
              )
            : null,
        ),
      );
    }

    function Panel({ badge, onToggle }) {
      const [filter, setFilter] = React.useState('all');
      const rows = badge.rows ?? [];

      const visible = rows.filter((row) => {
        if (filter === 'action' || filter === 'report') return row.stance === filter;
        if (filter === 'refuted') return row.verdict === 'refuted';
        if (filter === 'unknown') return row.verdict === 'unverifiable';
        return true;
      });

      const chip = (item) => {
        const active = filter === item.key;
        return h(
          'button',
          {
            key: item.key,
            type: 'button',
            onClick: () => setFilter(item.key),
            style: {
              padding: '0 7px',
              border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
              borderRadius: 999,
              background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: active ? 'var(--dsw-alias-label-primary)' : tone.idle,
              cursor: 'pointer',
              ...mono,
            },
          },
          item.label,
        );
      };

      return h(
        'div',
        {
          style: {
            marginTop: 6,
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            width: '100%',
            maxWidth: 620,
          },
        },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
          h('span', { style: { ...mono } }, `turn ${badge.turn} · ${badge.claims} 条断言`),
          h(
            'button',
            {
              type: 'button',
              onClick: onToggle,
              style: {
                border: 'none',
                background: 'transparent',
                color: tone.idle,
                cursor: 'pointer',
                ...mono,
              },
            },
            '收起',
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h(SummaryRow, { label: '✓ 有证据', value: badge.verified, color: tone.verified }),
          h(SummaryRow, { label: '✗ 被推翻', value: badge.refuted, color: tone.refuted }),
          h(SummaryRow, { label: '? 测不到', value: badge.unverifiable, color: tone.unknown }),
          h(SummaryRow, {
            label: '「我做了什么」',
            value: `${badge.actionTotal} 条（✓${badge.actionVerified} ✗${badge.actionRefuted} ?${badge.actionUnverifiable}）`,
          }),
          h(SummaryRow, {
            label: '完成性断言',
            value: `${badge.completions} 句 · 可查 ${badge.covered} 句（${badge.pct}%）· 未取证 ${badge.unbacked} 句`,
          }),
        ),
        h(
          'div',
          {
            style: {
              marginTop: 8,
              paddingTop: 6,
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
            },
          },
          ...FILTERS.map(chip),
          h('span', { style: { ...mono, color: tone.idle, marginLeft: 'auto' } }, `${visible.length} / ${rows.length}`),
        ),
        visible.length === 0
          ? h('div', { style: { ...mono, color: tone.idle, marginTop: 6 } }, '这个筛选下没有条目。')
          : h(
              'div',
              { style: { marginTop: 4, maxHeight: 264, overflowY: 'auto', paddingRight: 4 } },
              ...visible.map((row, index) => h(ClaimRow, { key: `${row.turn}-${index}-${row.quote.slice(0, 12)}`, row })),
            ),
        badge.hidden > 0
          ? h(
              'div',
              { style: { ...mono, color: tone.idle, marginTop: 6 } },
              `面板只带最近 ${rows.length} 条；更早的 ${badge.hidden} 条没送到客户端（用 CLI 或 claim_audit 看全部）。`,
            )
          : null,
        h(
          'div',
          { style: { ...mono, color: tone.idle, marginTop: 6 } },
          '? = 没有可执行核验，不是通过；纯链接、无动作词的句子不判定。',
        ),
      );
    }

    function LedgerBadge(props) {
      const badge = props.useProjection('claim-ledger');
      const [open, setOpen] = React.useState(false);
      // 还没有任何回合的台账时什么都不显示，避免空徽章占着输入框下面
      if (!badge || !badge.turn) return null;
      const toggle = () => setOpen((value) => !value);
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%' } },
        h(Line, { badge, open, onToggle: toggle }),
        open ? h(Panel, { badge, onToggle: toggle }) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'claim-ledger', order: 2, label: () => '断言台账' },
            LedgerBadge,
          ),
        );
      },
    };
  },
});
