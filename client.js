// dsh-token-ledger 客户端半：设置页「Token 账本」卡片 + 输入框下方今日用量徽标。
//
// 形态遵循 DSH 客户端模块体系：本文件是 CommonJS 工厂，通过
// window.__ModuleLoader__.load({id, factory}) 注册；导出 name / inject / apply。
// 只依赖图内一定存在的 "react"，其余 UI 全部自包含，避免版本耦合。
(() => {
  const ID = 'dsh-token-ledger'

  // 两个独立模块：设置页卡片与输入框徽标，各自注册到一个插槽。
  window.__ModuleLoader__.load({
    id: ID,
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      const react = require('react')
      const h = react.createElement
      const { useState, useEffect, useCallback, useRef } = react

      // 客户端 fiber 的依赖声明。两者都必须真实存在，否则 web boot 的
      // assertEntriesActive 会判定 pending 并让整次启动失败。
      // slots：注册 UI 的唯一途径；locale：文案绑定。
      const inject = ['slots', 'locale']

      const API = '/dsh-token-ledger/api'

      const NS = 'settings.dsh-token-ledger'
      const zh = {
        nav: 'Token 账本',
        title: 'Token 消耗',
        subtitle: '按本地日期统计 provider 上报用量，数据源为会话日志。',
        today: '今日',
        window: '窗口',
        days: '天',
        refresh: '刷新',
        refreshing: '刷新中…',
        exportCsv: '导出 CSV',
        day: '日期',
        uncached: '未缓存输入',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入',
        output: '输出',
        total: '合计',
        hitRate: '缓存命中率',
        calls: '请求数',
        allTime: '全时段',
        modelBreak: '按模型',
        sessions: '会话数',
        loading: '读取中…',
        empty: '暂无 token 记录。发起一次对话后即可看到数据。',
        error: '读取失败',
        hint: '命令行：/tokens [天数] | /tokens today | /tokens csv',
        badgeToday: '今日',
        badgeWeek: '7天',
        // 仪表盘
        overview: '总览',
        cumulative: '累计 Token 数',
        peak: '峰值 Token 数',
        peakOn: '峰值日期',
        longestChat: '最长聊天时长',
        currentStreak: '当前连续天数',
        longestStreak: '最长连续天数',
        activeDays: '活跃天数',
        turns: '轮次',
        userMsgs: '用户消息',
        toolCalls: '工具调用',
        toolErrors: '失败',
        activity: 'Token 活动',
        activityHint: '每格一天，颜色越深用量越大',
        topTools: '最常用的工具',
        successRate: '成功率',
        heatDaily: '每日',
        heatWeekly: '每周',
        heatCumulative: '累计',
        monthSuffix: '月',
        less: '少',
        more: '多',
        sessionsTitle: '会话明细',
        duration: '时长',
        title: '标题',
        noTitle: '（无标题）',
        nextStreakHint: '连续达成',
        dayUnit: '天',
      }
      const en = {
        nav: 'Token Ledger',
        title: 'Token Usage',
        subtitle: 'Provider-reported usage per local day, sourced from session logs.',
        today: 'Today',
        window: 'Window',
        days: 'days',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        exportCsv: 'Export CSV',
        day: 'Day',
        uncached: 'Uncached in',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write',
        output: 'Output',
        total: 'Total',
        hitRate: 'Hit rate',
        calls: 'Calls',
        allTime: 'All time',
        modelBreak: 'By model',
        sessions: 'Sessions',
        loading: 'Loading…',
        empty: 'No token records yet. Start a conversation and check again.',
        error: 'Failed to load',
        hint: 'CLI: /tokens [days] | /tokens today | /tokens csv',
        badgeToday: 'Today',
        badgeWeek: '7d',
        overview: 'Overview',
        cumulative: 'Cumulative tokens',
        peak: 'Peak tokens',
        peakOn: 'Peak day',
        longestChat: 'Longest chat',
        currentStreak: 'Current streak',
        longestStreak: 'Longest streak',
        activeDays: 'Active days',
        turns: 'Turns',
        userMsgs: 'User messages',
        toolCalls: 'Tool calls',
        toolErrors: 'failed',
        activity: 'Token activity',
        activityHint: 'One cell per day; darker means more usage',
        topTools: 'Most used tools',
        successRate: 'Success',
        heatDaily: 'Daily',
        heatWeekly: 'Weekly',
        heatCumulative: 'Cumulative',
        monthSuffix: '',
        less: 'Less',
        more: 'More',
        sessionsTitle: 'Sessions',
        duration: 'Duration',
        title: 'Title',
        noTitle: '(untitled)',
        nextStreakHint: 'streak',
        dayUnit: 'days',
      }

      let translate = (key) => key
      const useT = () => translate

      const apiUrl = (p) => {
        try {
          return new URL(p, window.location.origin).toString()
        } catch {
          return p
        }
      }

      async function apiJson(p, init) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 15000)
        try {
          const r = await fetch(apiUrl(p), Object.assign({ cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal }, init || {}))
          const text = await r.text()
          let data
          try {
            data = text ? JSON.parse(text) : null
          } catch {
            throw new Error(r.status + ' non-json: ' + text.slice(0, 120))
          }
          if (!r.ok) throw new Error((data && (data.error || data.message)) || r.status + ' ' + r.statusText)
          return data
        } finally {
          clearTimeout(timer)
        }
      }

      const nf = new Intl.NumberFormat('en-US')
      const fmt = (n) => nf.format(Math.round(Number(n) || 0))
      function compact(n) {
        const v = Math.round(Number(n) || 0)
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
        return String(v)
      }
      const pct = (r) => (Number(r || 0) * 100).toFixed(1) + '%'

      /**
       * 毫秒 → 人类可读时长。
       * 与宿主「最长聊天时长」的口径一致：这是**连续活动**时长，
       * 超过 30 分钟的静默间隔已被数据层剔除，不是墙钟差。
       */
      function dur(ms) {
        const v = Number(ms) || 0
        if (v <= 0) return '0 分'
        const sec = Math.round(v / 1000)
        const h = Math.floor(sec / 3600)
        const m = Math.floor((sec % 3600) / 60)
        if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
        if (m > 0) return `${m} 分`
        return `${sec} 秒`
      }

      /** 本地日期键（与后端 localDayKey 同口径）。 */
      const dayKeyOf = (d) => {
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      }

      // 配色一律走宿主的语义变量（--dsw-alias-*），它们已按浅/深主题分别取值。
      // 绝不写死颜色：本插件早期版本硬编码深色，在浅色主题下渲染成一条黑杠。
      // 每个变量都带兜底值，万一宿主改名也不会塌成透明/黑色。
      const V = {
        fg: 'var(--dsw-alias-label-primary, #1b1b1c)',
        dim: 'var(--dsw-alias-label-tertiary, #61666b)',
        line: 'var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
        lineStrong: 'var(--dsw-alias-border-l3, rgba(0,0,0,.12))',
        layer1: 'var(--dsw-alias-bg-layer-1, #fff)',
        layer2: 'var(--dsw-alias-bg-layer-2, #fff)',
        layer3: 'var(--dsw-alias-bg-layer-3, #fff)',
        hover: 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))',
        accent: 'var(--dsw-alias-state-warn-label, #dd8629)',
        blue: 'var(--dsw-alias-state-business-primary, #4176e6)',
        ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
        err: 'var(--dsw-alias-state-error-primary, #ec1313)',
        // 热力图：空格用主题自适应底色；1-4 级用宿主的**静态**蓝色阶
        // （static 变量不随深浅主题改变，因此热力梯度在两种主题下都稳定可读）。
        heat0: 'var(--dsw-alias-bg-module-platform, rgba(0,0,0,.04))',
        heat1: 'var(--dsw-static-deepseek-100, #e4edfd)',
        heat2: 'var(--dsw-static-deepseek-300, #b7c8fe)',
        heat3: 'var(--dsw-static-deepseek-450, #5686fe)',
        heat4: 'var(--dsw-static-deepseek-600, #4868b2)',
      }

      // 视觉方向：克制的「仪表」感——沿用宿主卡片语言，用琥珀色做数据强调。
      // 所有颜色都来自宿主变量，因此自动跟随浅/深主题。
      const CSS = `
.dshTlRoot{color:${V.fg};font-size:13px;line-height:1.5;}
.dshTlCard{background:${V.layer2};border:1px solid ${V.line};border-radius:12px;padding:16px 18px;}
.dshTlCard+.dshTlCard{margin-top:12px;}
.dshTlHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.dshTlTitle{font-size:15px;font-weight:600;margin:0;color:${V.fg};}
.dshTlSub{color:${V.dim};font-size:12px;margin:4px 0 0;}
.dshTlRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dshTlBtn{appearance:none;border:1px solid ${V.line};background:${V.layer1};color:${V.fg};border-radius:8px;padding:4px 11px;font-size:12px;line-height:20px;cursor:pointer;transition:border-color .15s,background .15s;}
.dshTlBtn:hover:not(:disabled){border-color:${V.lineStrong};background:${V.hover};}
.dshTlBtn:disabled{opacity:.55;cursor:default;}
.dshTlBtn--primary{border-color:${V.accent};color:${V.accent};}
.dshTlSel{appearance:none;border:1px solid ${V.line};background:${V.layer1};color:${V.fg};border-radius:8px;padding:4px 9px;font-size:12px;line-height:20px;}
.dshTlMetrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px;margin-top:14px;}
.dshTlMetric{background:${V.layer1};border:1px solid ${V.line};border-radius:10px;padding:9px 11px;}
.dshTlMetricK{color:${V.dim};font-size:11px;letter-spacing:.4px;}
.dshTlMetricV{font-size:18px;font-weight:600;margin-top:3px;font-variant-numeric:tabular-nums;color:${V.fg};}
.dshTlMetricV--accent{color:${V.accent};}
.dshTlMetricV--blue{color:${V.blue};}
.dshTlTableWrap{margin-top:14px;overflow:auto;max-height:340px;border:1px solid ${V.line};border-radius:10px;}
.dshTlTable{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12px;}
.dshTlTable th,.dshTlTable td{padding:6px 10px;text-align:right;white-space:nowrap;}
.dshTlTable th{position:sticky;top:0;background:${V.layer3};color:${V.dim};font-weight:500;font-size:11px;letter-spacing:.4px;z-index:1;}
.dshTlTable td{color:${V.fg};border-top:1px solid ${V.line};}
.dshTlTable td:first-child,.dshTlTable th:first-child{text-align:left;}
.dshTlTable tbody tr:hover td{background:${V.hover};}
.dshTlTable tbody tr.dshTlToday td{color:${V.accent};font-weight:600;}
.dshTlBar{display:inline-block;height:6px;border-radius:3px;background:${V.blue};vertical-align:middle;min-width:2px;}
.dshTlNote{margin-top:10px;color:${V.dim};font-size:11px;}
.dshTlErr{margin-top:10px;color:${V.err};font-size:12px;word-break:break-word;}
.dshTlList{margin:10px 0 0;padding:0;list-style:none;}
.dshTlList li{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-top:1px solid ${V.line};}
.dshTlList li:first-child{border-top:none;}
.dshTlList span:last-child{color:${V.dim};}

/* 输入框下方的用量徽标。
   dock 是 flex 容器：子项默认沿交叉轴拉伸成整行（这正是「黑杠」的成因），
   因此外层宽度收成内容宽、内层显式 align-self，两处一起阻止拉伸。 */
.dshTlBadgeWrap{display:inline-flex;align-self:center;align-items:center;flex:0 0 auto;width:fit-content;max-width:fit-content;}
.dshTlBadge{display:inline-flex;align-items:center;gap:6px;
  border:1px solid ${V.line};background:${V.layer1};color:${V.dim};
  border-radius:999px;padding:2px 9px;font-size:11px;line-height:18px;white-space:nowrap;cursor:default;}
.dshTlBadge b{color:${V.accent};font-weight:600;font-variant-numeric:tabular-nums;}
.dshTlBadge .dshTlSep{color:${V.line};}
.dshTlBadge .dshTlWeek{color:${V.dim};font-variant-numeric:tabular-nums;}
.dshTlDot{width:6px;height:6px;border-radius:50%;background:${V.ok};flex:0 0 auto;}
.dshTlDotErr{background:${V.err};}

/* ── 仪表盘 ───────────────────────────────────────────────── */
/* 顶部指标条：与参考图一致的「数值在上、标签在下」横向排布 */
.dshTlStats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:2px;
  border:1px solid ${V.line};border-radius:12px;overflow:hidden;margin-top:14px;background:${V.layer1};}
.dshTlStat{padding:12px 14px;text-align:center;border-right:1px solid ${V.line};}
.dshTlStat:last-child{border-right:none;}
.dshTlStatV{font-size:18px;font-weight:600;color:${V.fg};font-variant-numeric:tabular-nums;line-height:1.2;}
.dshTlStatK{font-size:11px;color:${V.dim};margin-top:3px;}

/* 热力图：CSS grid，7 行（星期日→六）× N 列（周） */
.dshTlHeat{margin-top:14px;overflow-x:auto;padding-bottom:4px;}
.dshTlHeatGrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,11px);gap:3px;width:max-content;}
.dshTlCell{width:11px;height:11px;border-radius:2px;background:${V.heat0};border:1px solid transparent;}
.dshTlCell--future{opacity:.35;}
/* 等级色必须定义在 .dshTlCell 之后：两者同为单类选择器，靠源码顺序决胜。
   （图例方块曾因把 background 写在等级规则之后而全部被覆盖成空色。） */
.dshTlL0{background:${V.heat0};}
.dshTlL1{background:${V.heat1};}
.dshTlL2{background:${V.heat2};}
.dshTlL3{background:${V.heat3};}
.dshTlL4{background:${V.heat4};}
.dshTlHeatMonths{display:grid;gap:3px;margin-top:6px;color:${V.dim};font-size:10px;width:max-content;}
/* 月份标签落在 11px 宽的网格列里，但文字本身约 20px：
   不能加 overflow:hidden，否则「3月」会被裁成半个字。
   标签间距由 MIN_LABEL_GAP=3 列（≥42px）保证，溢出不会互相压字。 */
.dshTlHeatMonth{grid-row:1;white-space:nowrap;}
.dshTlLegend{display:flex;align-items:center;gap:5px;margin-top:8px;color:${V.dim};font-size:10px;}
/* 不在这里写 background：等级色由 .dshTlL0..4 提供，避免覆盖 */
.dshTlLegendBox{width:11px;height:11px;border-radius:2px;}

/* 工具排行 */
.dshTlTool{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:4px 0;font-size:12px;}
.dshTlToolName{color:${V.fg};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshTlToolCount{color:${V.dim};font-variant-numeric:tabular-nums;}
.dshTlToolRate{color:${V.dim};font-variant-numeric:tabular-nums;min-width:46px;text-align:right;}
.dshTlToolBar{height:4px;border-radius:2px;background:${V.blue};margin-top:3px;}
`

      /**
       * 一次性注入样式表。
       * id 带版本号：升级后旧节点会被替换，避免 HMR 或热重载时残留旧样式。
       */
      const CSS_ID = 'dsh-token-ledger-style-v3'
      function ensureCss() {
        if (typeof document === 'undefined') return
        if (document.getElementById(CSS_ID) !== null) return
        // 清掉任何早期版本的样式节点
        for (const stale of ['dsh-token-ledger-style', 'dsh-token-ledger-style-v2']) {
          const el = document.getElementById(stale)
          if (el !== null) el.remove()
        }
        const el = document.createElement('style')
        el.id = CSS_ID
        el.textContent = CSS
        document.head.appendChild(el)
      }

      /**
       * 顶部指标条：数值在上、标签在下，横向等分。
       * 对应参考图的「累计 / 峰值 / 最长聊天时长 / 当前连续 / 最长连续」。
       */
      function StatBar({ data }) {
        const t = useT()
        const m = data.metrics
        if (m === undefined) return null
        const items = [
          { v: compact(m.cumulativeTokens), k: t('cumulative'), title: fmt(m.cumulativeTokens) },
          { v: compact(m.peakTokens), k: t('peak'), title: `${t('peakOn')}: ${m.peakDay ?? '-'}` },
          { v: dur(m.longestSessionMs), k: t('longestChat') },
          { v: `${m.currentStreak} ${t('dayUnit')}`, k: t('currentStreak') },
          { v: `${m.longestStreak} ${t('dayUnit')}`, k: t('longestStreak') },
        ]
        return h(
          'div',
          { className: 'dshTlStats' },
          items.map((it, i) =>
            h(
              'div',
              { className: 'dshTlStat', key: i, title: it.title },
              h('div', { className: 'dshTlStatV' }, it.v),
              h('div', { className: 'dshTlStatK' }, it.k)
            )
          )
        )
      }

      /**
       * Token 活动热力图。
       *
       * 布局：CSS grid，`grid-auto-flow: column` + 7 行，让每一列正好是一周，
       * 行序为星期日→六，与参考图一致。每格 title 给出日期与当日用量。
       */
      function Heatmap({ data }) {
        const t = useT()
        const hm = data.heatmap
        if (hm === undefined || hm.cells.length === 0) return null

        // 单元格：空格也要渲染，才能形成日历网格
        const cells = hm.cells.map((c) => {
          const cls = ['dshTlCell']
          if (c.totalTokens > 0) cls.push('dshTlL' + c.level)
          if (c.isFuture) cls.push('dshTlCell--future')
          return h('div', {
            key: c.day,
            className: cls.join(' '),
            title: `${c.day} · ${fmt(c.totalTokens)} tokens · ${fmt(c.calls)} ${t('calls')}`,
          })
        })

        // 月份刻度：取每列第一格，遇到月份变化就在该列打标签。
        // 用与网格相同的列结构（repeat(weeks, 11px) + 3px 间距）定位。
        //
        // 约束最小间距：首列常是「残月」（该周大部分属于上个月），
        // 紧跟的下一个月可能只差 1-2 列，两个标签会挤在一起。
        // 少于 3 列就不打新标签，与常见贡献图的处理一致。
        const MIN_LABEL_GAP = 3
        const monthLabels = []
        let lastMonth = null
        let lastWeek = -Infinity
        for (let w = 0; w < hm.weeks; w++) {
          const first = hm.cells[w * 7]
          if (first === undefined) continue
          const mo = Number(first.day.slice(5, 7))
          if (mo !== lastMonth && w - lastWeek >= MIN_LABEL_GAP) {
            monthLabels.push({ week: w, label: `${mo}${t('monthSuffix')}` })
            lastMonth = mo
            lastWeek = w
          } else if (mo !== lastMonth && w - lastWeek < MIN_LABEL_GAP) {
            // 与上一个标签太近：跳过，但记住这个月已出现过，避免后续重复判断
            lastMonth = mo
          }
        }

        return h(
          'div',
          { className: 'dshTlHeat' },
          h('div', { className: 'dshTlHeatGrid' }, cells),
          h(
            'div',
            {
              className: 'dshTlHeatMonths',
              style: { gridTemplateColumns: `repeat(${hm.weeks}, 11px)` },
            },
            monthLabels.map((ml) =>
              h('span', { key: ml.week, className: 'dshTlHeatMonth', style: { gridColumn: String(ml.week + 1) } }, ml.label)
            )
          ),
          h(
            'div',
            { className: 'dshTlLegend' },
            h('span', null, t('activityHint')),
            h('span', { style: { marginLeft: 'auto' } }, t('less')),
            ...[0, 1, 2, 3, 4].map((lv) =>
              h('span', { key: lv, className: `dshTlLegendBox dshTlL${lv}` })
            ),
            h('span', null, t('more'))
          )
        )
      }

      /** 最常用工具排行（对应「最常用的插件」）。 */
      function TopTools({ data }) {
        const t = useT()
        if (data.tools === undefined || data.tools.length === 0) return null
        const top = data.tools.slice(0, 8)
        const max = Math.max(1, ...top.map((x) => x.calls))
        return h(
          'div',
          null,
          h('div', { className: 'dshTlTitle', style: { fontSize: '13px', marginTop: '14px' } }, t('topTools')),
          h(
            'div',
            { style: { marginTop: '8px' } },
            top.map((tool) =>
              h(
                'div',
                { key: tool.name },
                h(
                  'div',
                  { className: 'dshTlTool' },
                  h('span', { className: 'dshTlToolName' }, tool.name),
                  h('span', { className: 'dshTlToolCount' }, `${fmt(tool.calls)} 次`),
                  h('span', { className: 'dshTlToolRate' }, `${(tool.successRate * 100).toFixed(0)}%`)
                ),
                h('div', { className: 'dshTlToolBar', style: { width: `${Math.max(2, Math.round((tool.calls / max) * 100))}%` } })
              )
            )
          )
        )
      }

      /** 设置页卡片。 */
      function LedgerSection() {
        const t = useT()
        const [days, setDays] = useState(30)
        const [data, setData] = useState(null)
        const [busy, setBusy] = useState(false)
        const [err, setErr] = useState(null)
        const [showModels, setShowModels] = useState(false)
        const [showSessions, setShowSessions] = useState(false)
        const alive = useRef(true)

        useEffect(() => () => {
          alive.current = false
        }, [])

        const load = useCallback(
          async (n, force) => {
            setBusy(true)
            setErr(null)
            try {
              const q = `${API}/summary?days=${n}${force ? '&force=1' : ''}`
              const r = await apiJson(q)
              if (alive.current) setData(r)
            } catch (e) {
              if (alive.current) setErr(String(e && e.message ? e.message : e))
            } finally {
              if (alive.current) setBusy(false)
            }
          },
          []
        )

        useEffect(() => {
          load(days, false)
        }, [days, load])

        const maxTotal = data === null ? 0 : Math.max(1, ...data.days.map((d) => d.totalTokens))
        const todayRow = data === null ? null : data.days.find((d) => d.day === data.today) || null

        const rows = data === null ? [] : data.days.slice().reverse()

        return h(
          'div',
          { className: 'dshTlRoot' },
          h(
            'div',
            { className: 'dshTlCard' },
            h(
              'div',
              { className: 'dshTlHead' },
              h(
                'div',
                null,
                h('h3', { className: 'dshTlTitle' }, t('title')),
                h('p', { className: 'dshTlSub' }, t('subtitle'))
              ),
              h(
                'div',
                { className: 'dshTlRow' },
                h(
                  'select',
                  {
                    className: 'dshTlSel',
                    value: String(days),
                    onChange: (e) => setDays(Number(e.target.value)),
                  },
                  [7, 14, 30, 90, 180, 365].map((n) => h('option', { key: n, value: String(n) }, `${n} ${t('days')}`))
                ),
                h(
                  'button',
                  { className: 'dshTlBtn dshTlBtn--primary', disabled: busy, onClick: () => load(days, true) },
                  busy ? t('refreshing') : t('refresh')
                ),
                h(
                  'button',
                  { className: 'dshTlBtn', onClick: () => window.open(apiUrl(`${API}/export.csv?days=${days}`), '_blank') },
                  t('exportCsv')
                )
              )
            ),
            err !== null ? h('div', { className: 'dshTlErr' }, `${t('error')}: ${err}`) : null,
            data === null && err === null ? h('div', { className: 'dshTlNote' }, t('loading')) : null,
            data !== null
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'dshTlMetrics' },
                    h(
                      'div',
                      { className: 'dshTlMetric' },
                      h('div', { className: 'dshTlMetricK' }, t('today')),
                      h('div', { className: 'dshTlMetricV dshTlMetricV--accent' }, todayRow === null ? '0' : fmt(todayRow.totalTokens))
                    ),
                    h(
                      'div',
                      { className: 'dshTlMetric' },
                      h('div', { className: 'dshTlMetricK' }, `${days} ${t('days')}`),
                      h('div', { className: 'dshTlMetricV' }, fmt(data.recentTotals.totalTokens))
                    ),
                    h(
                      'div',
                      { className: 'dshTlMetric' },
                      h('div', { className: 'dshTlMetricK' }, t('cacheRead')),
                      h('div', { className: 'dshTlMetricV dshTlMetricV--blue' }, compact(data.recentTotals.cacheReadTokens))
                    ),
                    h(
                      'div',
                      { className: 'dshTlMetric' },
                      h('div', { className: 'dshTlMetricK' }, t('output')),
                      h('div', { className: 'dshTlMetricV' }, compact(data.recentTotals.outputTokens))
                    ),
                    h(
                      'div',
                      { className: 'dshTlMetric' },
                      h('div', { className: 'dshTlMetricK' }, t('hitRate')),
                      h('div', { className: 'dshTlMetricV' }, pct(data.recentTotals.cacheHitRate))
                    ),
                    h(
                      'div',
                      { className: 'dshTlMetric' },
                      h('div', { className: 'dshTlMetricK' }, t('calls')),
                      h('div', { className: 'dshTlMetricV' }, fmt(data.recentTotals.calls))
                    )
                  ),
                  data.days.length === 0
                    ? h('div', { className: 'dshTlNote' }, t('empty'))
                    : h(
                        'div',
                        { className: 'dshTlTableWrap' },
                        h(
                          'table',
                          { className: 'dshTlTable' },
                          h(
                            'thead',
                            null,
                            h(
                              'tr',
                              null,
                              [
                                t('day'),
                                t('total'),
                                t('uncached'),
                                t('cacheRead'),
                                t('output'),
                                t('hitRate'),
                                t('calls'),
                              ].map((label) => h('th', { key: label }, label))
                            )
                          ),
                          h(
                            'tbody',
                            null,
                            rows.map((d) =>
                              h(
                                'tr',
                                { key: d.day, className: d.day === (data && data.today) ? 'dshTlToday' : undefined },
                                h('td', null, d.day),
                                h(
                                  'td',
                                  null,
                                  h('span', {
                                    className: 'dshTlBar',
                                    style: { width: Math.max(2, Math.round((d.totalTokens / maxTotal) * 64)) + 'px' },
                                    title: fmt(d.totalTokens),
                                  }),
                                  ' ',
                                  fmt(d.totalTokens)
                                ),
                                h('td', null, fmt(d.uncachedInputTokens)),
                                h('td', null, fmt(d.cacheReadTokens)),
                                h('td', null, fmt(d.outputTokens)),
                                h('td', null, pct(d.cacheHitRate)),
                                h('td', null, fmt(d.calls))
                              )
                            )
                          )
                        )
                      ),
                  h(
                    'div',
                    { className: 'dshTlNote' },
                    `${t('allTime')}: ${fmt(data.allTime.totalTokens)} · ${t('sessions')}: ${data.sessionCount} · ${t('hint')}`
                  )
                )
              : null
          ),
          // ── 仪表盘：指标条 + 热力图 + 工具排行 ──────────────────
          data !== null
            ? h(
                'div',
                { className: 'dshTlCard' },
                h('h3', { className: 'dshTlTitle' }, t('overview')),
                h(StatBar, { data }),
                h('div', { className: 'dshTlTitle', style: { fontSize: '13px', marginTop: '16px' } }, t('activity')),
                h(Heatmap, { data }),
                h(TopTools, { data })
              )
            : null,
          data !== null && data.models.length > 0
            ? h(
                'div',
                { className: 'dshTlCard' },
                h(
                  'div',
                  { className: 'dshTlRow', style: { justifyContent: 'space-between' } },
                  h('h3', { className: 'dshTlTitle', style: { fontSize: '14px' } }, t('modelBreak')),
                  h('button', { className: 'dshTlBtn', onClick: () => setShowModels((v) => !v) }, showModels ? '−' : '+')
                ),
                showModels
                  ? h(
                      'ul',
                      { className: 'dshTlList' },
                      data.models.map((m) =>
                        h(
                          'li',
                          { key: `${m.provider}\u0000${m.model}` },
                          h('span', null, `${m.provider ? m.provider + '/' : ''}${m.model}`),
                          h('span', null, `${fmt(m.totalTokens)} · ${fmt(m.calls)} ${t('calls')}`)
                        )
                      )
                    )
                  : null
              )
            : null,
          // ── 会话明细：标题 + 时长 + 用量 ─────────────────────────
          data !== null && data.sessions.length > 0
            ? h(
                'div',
                { className: 'dshTlCard' },
                h(
                  'div',
                  { className: 'dshTlRow', style: { justifyContent: 'space-between' } },
                  h('h3', { className: 'dshTlTitle', style: { fontSize: '14px' } }, t('sessionsTitle')),
                  h(
                    'button',
                    { className: 'dshTlBtn', onClick: () => setShowSessions((v) => !v) },
                    showSessions ? '−' : '+'
                  )
                ),
                showSessions
                  ? h(
                      'div',
                      { className: 'dshTlTableWrap', style: { maxHeight: '300px' } },
                      h(
                        'table',
                        { className: 'dshTlTable' },
                        h(
                          'thead',
                          null,
                          h(
                            'tr',
                            null,
                            [t('title'), t('duration'), t('turns'), t('total')].map((label) =>
                              h('th', { key: label }, label)
                            )
                          )
                        ),
                        h(
                          'tbody',
                          null,
                          data.sessions.slice(0, 30).map((s) =>
                            h(
                              'tr',
                              { key: s.id },
                              h(
                                'td',
                                { style: { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: s.title ?? s.id },
                                s.title === null || s.title === undefined ? t('noTitle') : String(s.title).slice(0, 40)
                              ),
                              h('td', null, dur(s.spanMs)),
                              h('td', null, fmt(s.turns)),
                              h('td', null, fmt(s.totalTokens))
                            )
                          )
                        )
                      )
                    )
                  : null
              )
            : null
        )
      }

      /**
       * 输入框下方的用量徽标。
       *
       * 宿主自己的统计条（`7 轮 43 步 · 156 tok/s · 4.6M tok · 缓存命中 91%`）报的是
       * **本会话**的实时数据，所以这里刻意只补它没有的维度：**今日**与**近 7 天**累计。
       *
       * 外层用一个 width:fit-content 的普通 span 包住徽标：dock 是 flex 容器，
       * 直接放 inline-flex 子项会被沿交叉轴拉伸成整行——那正是「黑杠」的成因。
       */
      function TodayBadge() {
        const t = useT()
        const [data, setData] = useState(null)
        const [bad, setBad] = useState(false)
        const alive = useRef(true)

        useEffect(() => {
          alive.current = true
          let timer = null
          const tick = async () => {
            try {
              const r = await apiJson(`${API}/summary?days=7`)
              if (!alive.current) return
              setData(r)
              setBad(false)
            } catch {
              if (alive.current) setBad(true)
            }
          }
          tick()
          timer = setInterval(tick, 60000)
          return () => {
            alive.current = false
            if (timer !== null) clearInterval(timer)
          }
        }, [])

        const todayRow = data === null ? null : data.days.find((d) => d.day === data.today) || null
        const todayTotal = todayRow === null ? 0 : todayRow.totalTokens

        const title =
          data === null
            ? t('loading')
            : todayRow === null
              ? t('empty')
              : [
                  `${t('today')} ${fmt(todayTotal)} tokens · ${fmt(todayRow.calls)} ${t('calls')}`,
                  `近 7 天 ${fmt(data.recentTotals.totalTokens)} tokens`,
                  `${t('allTime')} ${fmt(data.allTime.totalTokens)} tokens`,
                ].join('\n')

        return h(
          'span',
          { className: 'dshTlBadgeWrap' },
          h(
            'span',
            { className: 'dshTlBadge', title },
            h('span', { className: bad ? 'dshTlDot dshTlDotErr' : 'dshTlDot' }),
            h('span', null, t('badgeToday')),
            h('b', null, compact(todayTotal)),
            data !== null && data.recentTotals.calls > 0
              ? h('span', { className: 'dshTlSep' }, '/')
              : null,
            data !== null && data.recentTotals.calls > 0
              ? h('span', { className: 'dshTlWeek' }, `${t('badgeWeek')} ${compact(data.recentTotals.totalTokens)}`)
              : null
          )
        )
      }

      function apply(ctx) {
        ensureCss()
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-token-ledger: dictionaries')
          translate = ctx.locale.bind(NS)
        } catch {
          // locale 不可用时保持 key 原文，UI 仍可用
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-token-ledger',
              order: 60,
              label: () => translate('nav'),
              locale: NS,
            },
            LedgerSection
          )
        )

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-token-ledger',
              order: 40,
              locale: NS,
            },
            TodayBadge
          )
        )
      }

      exports.name = ID
      exports.inject = inject
      exports.apply = apply
      return module.exports
    },
  })
})()
