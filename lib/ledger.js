/**
 * dsh-token-ledger — 数据层。
 *
 * 从会话日志（`sessions/<workspace>/<session>/session.v3.jsonl.zstd`）重建
 * 每个会话的 provider 上报 token 用量，并按本地日期聚合。
 *
 * 折叠语义与 DSH 官方 `tokenUsage` 投影（dsh-token-meter, stateVersion 2）逐字节对齐，
 * 这是实测验证过的：对 20 个会话，本模块的折叠结果与官方投影缓存
 * `storages/session_projcache/sessions/*.json` 的 `tokenUsage.val.totals` 100% 一致。
 *
 * 之所以不直接读官方投影缓存，是因为缓存只覆盖「曾被加载过」的会话，
 * 且可能落后于日志尾部；日志是权威且完整的来源。
 */

import fs from 'node:fs'
import path from 'node:path'
import { readZstdLines } from './zstd-frames.js'

/** 四个互不重叠的 provider 用量桶。outputTokens 已含 reasoning，不重复计入。 */
const ZERO = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

const addInto = (target, src) => {
  target.uncachedInputTokens += src.uncachedInputTokens
  target.outputTokens += src.outputTokens
  target.cacheReadTokens += src.cacheReadTokens
  target.cacheWriteTokens += src.cacheWriteTokens
}

const bucketsEqual = (a, b) =>
  a.uncachedInputTokens === b.uncachedInputTokens &&
  a.outputTokens === b.outputTokens &&
  a.cacheReadTokens === b.cacheReadTokens &&
  a.cacheWriteTokens === b.cacheWriteTokens

/** 把 provider usage 归一到四个桶；缺失的可选桶按 0 计。 */
const bucketsFrom = (u) => ({
  uncachedInputTokens: num(u.inputTokens),
  outputTokens: num(u.outputTokens),
  cacheReadTokens: num(u.cacheReadTokens),
  cacheWriteTokens: num(u.cacheWriteTokens),
})

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/**
 * 取事件携带的 usage 样本。
 *
 * `assistant/message` 的 usage 在 `data.usage`（实测 302/302 全带）；
 * `assistant/attempt` 可能把它嵌在 stream 的最后一个 usage chunk 里
 * （与官方 `lastAssistantStreamChunk(stream,'usage')` 同义）。
 * @param {object} ev 会话事件
 * @returns {object|undefined} provider usage 记录
 */
function usageOf(ev) {
  if (ev.type === 'assistant/message' && ev.data && ev.data.usage !== undefined) return ev.data.usage
  if (ev.type !== 'assistant/message' && ev.type !== 'assistant/attempt') return undefined
  const stream = ev.data && ev.data.stream
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i--) {
    const c = stream[i]
    if (c && c.kind === 'usage' && c.usage) return c.usage
  }
  return undefined
}

/** 事件路由（provider/model），用于按模型拆分。 */
function routeOf(ev) {
  const src = ev.data && ev.data.message && ev.data.message.source
  if (!src) return undefined
  const provider = String(src.provider || '')
  const model = String(src.model || '')
  if (!model) return undefined
  return { provider, model }
}

/** epoch 毫秒 → 本地时区 `YYYY-MM-DD`。 */
export function localDayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 折叠单个会话的完整事件序列，产出该会话的用量贡献。
 *
 * 复刻官方 tokenUsage 投影：
 * - 同一 `(turn, step)` 的新样本**替换**旧样本，而不是累加——这是重试与
 *   provider 多次上报同一 step 时的正确语义，朴素求和会高估。
 * - `llm/retry-started` 关闭当前计费槽，使重试后的 attempt 重新开始累加。
 * - 样本内容与已计入的完全相同时跳过，避免重复事件污染总量。
 *
 * @param {object[]} events 按 seq 递增的会话事件
 * @returns {{byDay:Map<string,object>, byModel:Map<string,object>, byRouteDay:Map<string,object>,
 *            tools:Map<string,{calls:number,errors:number}>, calls:number,
 *            firstTime:number|null, lastTime:number|null, activeSpanMs:number,
 *            turns:number, userMessages:number, sessionTitle:string|null}}
 */
export function foldSession(events) {
  const byDay = new Map()
  const byModel = new Map()
  const byRouteDay = new Map()
  const tools = new Map() // 工具名 -> { calls, errors }
  // callId -> 工具名。tool/result 只带 callId，不含工具名，
  // 因此必须借 tool/call 建立映射才能把失败归因到具体工具。
  const pendingToolCalls = new Map()
  let sessionTitle = null
  let last = null
  let firstTime = null
  let lastTime = null
  let userMessages = 0
  let turns = 0
  /**
   * 连续活动区间内的最长「静默间隔」阈值：超过它就算会话已中断。
   *
   * 「聊天时长」应为用户实际在一起的连续时段，而不是从第一次到最后一次的墙钟差值——
   * 否则一个放了三天没关的会话会被算成 72 小时。实测本机有个会话首尾差 48 小时，
   * 但中间是隔夜中断，直接相减会严重高估。
   */
  const IDLE_GAP_MS = 30 * 60 * 1000
  const activityTimes = []

  /** 按签名把一份贡献加到各聚合表。delta 为负即为回冲。 */
  const apply = (buckets, day, modelKey, provider, model, deltaCalls) => {
    if (day !== null) {
      let t = byDay.get(day)
      if (t === undefined) {
        t = { ...ZERO(), calls: 0 }
        byDay.set(day, t)
      }
      addInto(t, buckets)
      t.calls += deltaCalls
    }
    if (modelKey !== null) {
      let t = byModel.get(modelKey)
      if (t === undefined) {
        t = { ...ZERO(), calls: 0, provider, model }
        byModel.set(modelKey, t)
      }
      addInto(t, buckets)
      t.calls += deltaCalls
    }
    if (day !== null && modelKey !== null) {
      let t = byRouteDay.get(`${day}\u0000${modelKey}`)
      if (t === undefined) {
        t = { ...ZERO(), calls: 0, day, provider, model }
        byRouteDay.set(`${day}\u0000${modelKey}`, t)
      }
      addInto(t, buckets)
      t.calls += deltaCalls
    }
  }

  for (const ev of events) {
    // ── 工具调用统计（对应「最常用的插件」/ 成功率）──────────────
    // 计数口径：tool/call 记一次调用；同 callId 的 tool/result 若带 error 字段
    // 记为失败。工具名来自 tool/call 的 name（实测 912/912 都有）。
    if (ev.type === 'tool/call') {
      const n = ev.data && typeof ev.data.name === 'string' ? ev.data.name : null
      const cid = ev.data && typeof ev.data.callId === 'string' ? ev.data.callId : null
      if (n !== null) {
        let rec = tools.get(n)
        if (rec === undefined) {
          rec = { calls: 0, errors: 0 }
          tools.set(n, rec)
        }
        rec.calls += 1
        if (cid !== null) pendingToolCalls.set(cid, n)
      }
      continue
    }
    if (ev.type === 'tool/result') {
      // 反查该 result 对应的工具名：按 callId 从已记录序列里回找最近一次 call
      const callId = ev.data && ev.data.message && ev.data.message.source ? ev.data.message.source.callId : undefined
      const failed = ev.data && ev.data.error !== undefined
      if (typeof callId === 'string') {
        // 记录 callId -> 工具的映射，供 result 归因
        const name = pendingToolCalls.get(callId)
        if (name !== undefined) {
          pendingToolCalls.delete(callId)
          if (failed) {
            const rec = tools.get(name)
            if (rec !== undefined) rec.errors += 1
          }
        }
      }
      continue
    }

    // ── 对话规模（轮次 / 用户消息数）──────────────────────────
    if (ev.type === 'turn/start') {
      turns += 1
      continue
    }
    if (ev.type === 'user/message') {
      userMessages += 1
      continue
    }
    if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') {
      sessionTitle = ev.data.title
      continue
    }

    if (ev.type === 'llm/retry-started') {
      const d = ev.data
      if (last !== null && d && last.turn === d.turn && last.step === d.step) last = null
      continue
    }
    if (ev.type !== 'assistant/message' && ev.type !== 'assistant/attempt') continue

    const sample = usageOf(ev)
    if (sample === undefined) continue
    const d = ev.data || {}
    const turn = num(d.turn)
    const step = num(d.step)
    const next = bucketsFrom(sample)

    const previous = last !== null && last.turn === turn && last.step === step ? last : null
    // 样本与已计入的完全一致：重复事件，不重复计量
    if (previous !== null && bucketsEqual(previous.buckets, next)) continue

    const time = typeof ev.time === 'number' ? ev.time : null
    if (time !== null) {
      if (firstTime === null || time < firstTime) firstTime = time
      if (lastTime === null || time > lastTime) lastTime = time
      activityTimes.push(time)
    }
    const day = time === null ? null : localDayKey(time)
    const route = routeOf(ev)
    const provider = route === undefined ? '' : route.provider
    const model = route === undefined ? '' : route.model
    const modelKey = route === undefined ? null : `${route.provider}\u0000${route.model}`

    // 替换语义：先把旧样本从其**原本记录的**日期/模型槽整体回冲，
    // 再把新样本计入当前槽。跨午夜或跨模型的重试因此不会留下高估。
    if (previous !== null) {
      const neg = {}
      for (const k of Object.keys(previous.buckets)) neg[k] = -previous.buckets[k]
      apply(neg, previous.day, previous.modelKey, previous.provider, previous.model, -1)
    }
    apply(next, day, modelKey, provider, model, 1)

    last = { turn, step, buckets: next, day, modelKey, provider, model }
  }

  // calls 必须与日桶口径一致：同 (turn,step) 的替换是「同一请求的更好样本」，
  // 不增加请求数。直接把各日桶的净计数汇总，保证 days 之和恒等于总量。
  let netCalls = 0
  for (const slot of byDay.values()) netCalls += slot.calls

  /**
   * 活跃跨度：把带 usage 的时刻排序，累加所有不超过 IDLE_GAP_MS 的相邻间隔。
   * 这样隔夜的断点不会被计入「聊天时长」。
   */
  activityTimes.sort((a, b) => a - b)
  let activeSpanMs = 0
  for (let i = 1; i < activityTimes.length; i++) {
    const gap = activityTimes[i] - activityTimes[i - 1]
    if (gap > 0 && gap <= IDLE_GAP_MS) activeSpanMs += gap
  }

  return {
    byDay,
    byModel,
    byRouteDay,
    tools,
    calls: netCalls,
    firstTime,
    lastTime,
    activeSpanMs,
    turns,
    userMessages,
    sessionTitle,
  }
}

/** 递归收集会话日志文件。 */
export function collectSessionLogs(sessionsRoot) {
  const out = []
  if (!fs.existsSync(sessionsRoot)) return out
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/^session.*\.jsonl(\.zstd)?$/.test(e.name)) out.push(p)
    }
  }
  walk(sessionsRoot, 0)
  return out
}

/**
 * 增量缓存：按 (mtimeMs, size) 复用每个文件的折叠结果。
 *
 * 实测 20 个会话 / 4.6MB 全量折叠约 200ms，但会话库会持续增长，
 * 缓存让重复查询只处理发生变化的文件。
 */
export class SessionLedger {
  /**
   * @param {string} sessionsRoot `sessions` 目录绝对路径
   */
  constructor(sessionsRoot) {
    this.sessionsRoot = sessionsRoot
    this._cache = new Map()
    this._lastScan = null
  }

  /**
   * 扫描全部会话并按日期聚合。
   * @param {{now?:number, force?:boolean}} [opts]
   * @returns {object} 聚合报告
   */
  scan(opts = {}) {
    const files = collectSessionLogs(this.sessionsRoot)
    const seen = new Set()
    let reparsed = 0
    let reused = 0
    let badFrames = 0
    let totalEvents = 0

    const sessions = []
    const dayTotals = new Map()
    const modelTotals = new Map()
    const routeDay = new Map()
    const toolTotals = new Map() // 工具名 -> { calls, errors }
    let totalTurns = 0
    let totalUserMessages = 0

    for (const file of files) {
      seen.add(file)
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      const key = `${stat.mtimeMs}:${stat.size}`
      let entry = this._cache.get(file)
      if (opts.force === true || entry === undefined || entry.key !== key) {
        const events = []
        let res
        try {
          res = readZstdLines(fs.readFileSync(file), (line) => {
            try {
              events.push(JSON.parse(line))
            } catch {}
          })
        } catch {
          continue
        }
        badFrames += res.badFrames
        totalEvents += events.length
        const folded = foldSession(events)
        entry = { key, folded, eventCount: events.length, bytes: stat.size, mtimeMs: stat.mtimeMs }
        this._cache.set(file, entry)
        reparsed += 1
      } else {
        reused += 1
        totalEvents += entry.eventCount
      }

      const folded = entry.folded
      const dayKey = path.basename(path.dirname(file))

      for (const [day, slot] of folded.byDay) {
        let t = dayTotals.get(day)
        if (t === undefined) {
          t = { ...ZERO(), calls: 0, sessions: new Set() }
          dayTotals.set(day, t)
        }
        addInto(t, slot)
        t.calls += slot.calls
        t.sessions.add(dayKey)
      }
      for (const [k, slot] of folded.byModel) {
        let t = modelTotals.get(k)
        if (t === undefined) {
          t = { ...ZERO(), calls: 0, provider: slot.provider, model: slot.model }
          modelTotals.set(k, t)
        }
        addInto(t, slot)
        t.calls += slot.calls
      }
      for (const [k, slot] of folded.byRouteDay) {
        let t = routeDay.get(k)
        if (t === undefined) {
          t = { ...ZERO(), calls: 0, day: slot.day, provider: slot.provider, model: slot.model }
          routeDay.set(k, t)
        }
        addInto(t, slot)
        t.calls += slot.calls
      }

      // 累计工具调用（跨会话），对应「最常用的插件」
      for (const [name, rec] of folded.tools ?? []) {
        let t = toolTotals.get(name)
        if (t === undefined) {
          t = { calls: 0, errors: 0 }
          toolTotals.set(name, t)
        }
        t.calls += rec.calls
        t.errors += rec.errors
      }
      totalTurns += folded.turns ?? 0
      totalUserMessages += folded.userMessages ?? 0

      if (folded.calls > 0) {
        const totals = ZERO()
        for (const slot of folded.byDay.values()) addInto(totals, slot)
        // 会话活跃跨度：用于「最长聊天时长」。用连续活动区间，
        // 而非首尾时间差——隔夜中断不应计入时长。
        const sessionStart = folded.firstTime
        const sessionEnd = folded.lastTime
        const spanMs = folded.activeSpanMs ?? 0
        sessions.push({
          id: dayKey,
          workspace: path.basename(path.dirname(path.dirname(file))),
          title: folded.sessionTitle ?? null,
          totals,
          calls: folded.calls,
          turns: folded.turns ?? 0,
          userMessages: folded.userMessages ?? 0,
          firstTime: sessionStart,
          lastTime: sessionEnd,
          spanMs,
          wallSpanMs:
            sessionStart !== null && sessionEnd !== null ? Math.max(0, sessionEnd - sessionStart) : 0,
          bytes: entry.bytes,
        })
      }
    }

    // 清理已删除会话的缓存项
    for (const cached of [...this._cache.keys()]) {
      if (!seen.has(cached)) this._cache.delete(cached)
    }

    const days = [...dayTotals.entries()]
      .map(([day, t]) => ({
        day,
        uncachedInputTokens: t.uncachedInputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        totalTokens:
          t.uncachedInputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
        calls: t.calls,
        sessions: t.sessions.size,
      }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))

    const models = [...modelTotals.values()]
      .map((t) => ({
        provider: t.provider,
        model: t.model,
        uncachedInputTokens: t.uncachedInputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        totalTokens:
          t.uncachedInputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
        calls: t.calls,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)

    const breakdown = [...routeDay.values()]
      .map((t) => ({
        day: t.day,
        provider: t.provider,
        model: t.model,
        uncachedInputTokens: t.uncachedInputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        totalTokens:
          t.uncachedInputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
        calls: t.calls,
      }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.totalTokens - a.totalTokens))

    const tools = [...toolTotals.entries()]
      .map(([name, t]) => ({
        name,
        calls: t.calls,
        errors: t.errors,
        ok: t.calls - t.errors,
        successRate: t.calls === 0 ? 1 : (t.calls - t.errors) / t.calls,
      }))
      .sort((a, b) => b.calls - a.calls)

    const allTime = ZERO()
    for (const d of days) {
      allTime.uncachedInputTokens += d.uncachedInputTokens
      allTime.outputTokens += d.outputTokens
      allTime.cacheReadTokens += d.cacheReadTokens
      allTime.cacheWriteTokens += d.cacheWriteTokens
    }

    const now = opts.now ?? Date.now()
    const today = localDayKey(now)

    /** 有消耗的日期集合（升序），连续天数基于它计算。 */
    const activeDays = days
      .filter((d) => d.totalTokens > 0)
      .map((d) => d.day)
      .sort()

    /**
     * 连续活跃天数。
     *
     * current：从今天（或昨天，允许「今天还没开始用」）向前连续计数。
     * longest：历史最长连续区间。用日期字符串做日历减法，避免夏令时/时区误差。
     */
    const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000)
    let longestStreak = 0
    let run = 0
    let prev = null
    for (const day of activeDays) {
      run = prev !== null && dayDiff(prev, day) === 1 ? run + 1 : 1
      if (run > longestStreak) longestStreak = run
      prev = day
    }
    let currentStreak = 0
    if (activeDays.length > 0) {
      const lastActive = activeDays[activeDays.length - 1]
      const gapToToday = dayDiff(lastActive, today)
      // 今天或昨天有活动都算「当前连续」仍在进行
      if (gapToToday <= 1) {
        currentStreak = 1
        for (let i = activeDays.length - 1; i > 0; i--) {
          if (dayDiff(activeDays[i - 1], activeDays[i]) === 1) currentStreak += 1
          else break
        }
      }
    }

    /** 单日峰值（对应「峰值 Token 数」）。 */
    const peak = days.reduce((best, d) => (best === null || d.totalTokens > best.totalTokens ? d : best), null)

    /** 最长会话时长（对应「最长聊天时长」）。 */
    const longestSession = sessions.reduce(
      (best, s) => (best === null || s.spanMs > best.spanMs ? s : best),
      null
    )

    const enrichedSessions = sessions
      .map((s) => ({ ...s }))
      .sort((a, b) =>
        b.totals.outputTokens + b.totals.uncachedInputTokens - (a.totals.outputTokens + a.totals.uncachedInputTokens)
      )
      .slice(0, 100)

    this._lastScan = {
      generatedAt: now,
      today,
      days,
      models,
      tools,
      breakdown,
      sessions: enrichedSessions,
      allTime: {
        ...allTime,
        totalTokens:
          allTime.uncachedInputTokens + allTime.outputTokens + allTime.cacheReadTokens + allTime.cacheWriteTokens,
      },
      metrics: {
        // 与图片对应的仪表盘指标
        cumulativeTokens: allTime.uncachedInputTokens + allTime.outputTokens + allTime.cacheReadTokens + allTime.cacheWriteTokens,
        peakTokens: peak === null ? 0 : peak.totalTokens,
        peakDay: peak === null ? null : peak.day,
        longestSessionMs: longestSession === null ? 0 : longestSession.spanMs,
        longestSessionId: longestSession === null ? null : longestSession.id,
        currentStreak,
        longestStreak,
        activeDayCount: activeDays.length,
        totalTurns,
        totalUserMessages,
        totalToolCalls: tools.reduce((a, t) => a + t.calls, 0),
        totalToolErrors: tools.reduce((a, t) => a + t.errors, 0),
        topTool: tools.length === 0 ? null : tools[0].name,
        topToolCalls: tools.length === 0 ? 0 : tools[0].calls,
      },
      sessionCount: sessions.length,
      fileCount: files.length,
      stats: { reparsed, reused, badFrames, totalEvents },
    }
    return this._lastScan
  }

  /**
   * 取最近 N 天的日报表（按日升序，便于画图）。
   * @param {number} days 天数
   * @param {{now?:number, force?:boolean}} [opts]
   */
  recent(days, opts = {}) {
    const r = this.scan(opts)
    const today = localDayKey(opts.now ?? Date.now())
    const end = new Date(today + 'T00:00:00')
    const want = new Set()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86400000)
      const p = (n) => String(n).padStart(2, '0')
      want.add(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
    }
    const filled = []
    for (const day of [...want].sort()) {
      const hit = r.days.find((d) => d.day === day)
      filled.push(
        hit || {
          day,
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          calls: 0,
          sessions: 0,
        }
      )
    }
    return filled
  }

  /**
   * 取最近 N 天用于热力图：按周分列、按星期分行的日历网格。
   *
   * 返回从起始周的周日到指定日期为止的完整网格（含无消耗的空格子），
   * 使前端可以直接按 GitHub 贡献图的形状渲染。
   * @param {number} weeks 周数（列数）
   * @param {{now?:number, force?:boolean}} [opts]
   * @returns {{cells:Array<{day:string,week:number,weekday:number,totalTokens:number,calls:number,level:number,isFuture:boolean}>,
   *            weeks:number, maxTokens:number, totalTokens:number, activeDays:number}}
   */
  heatmap(weeks, opts = {}) {
    const r = this.scan(opts)
    const now = opts.now ?? Date.now()
    const today = localDayKey(now)

    // 以今天所在周的周日为最后一列，向前推 weeks 列
    const todayDate = new Date(today + 'T00:00:00')
    const todayWeekday = todayDate.getDay() // 0=周日
    const gridEnd = new Date(todayDate.getTime() + (6 - todayWeekday) * 86400000)
    const gridStart = new Date(gridEnd.getTime() - (weeks * 7 - 1) * 86400000)

    const byDay = new Map(r.days.map((d) => [d.day, d]))
    const pad = (n) => String(n).padStart(2, '0')
    const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

    const cells = []
    let maxTokens = 0
    let totalTokens = 0
    let activeDays = 0
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(gridStart.getTime() + i * 86400000)
      const k = key(d)
      const hit = byDay.get(k)
      const tot = hit === undefined ? 0 : hit.totalTokens
      if (tot > maxTokens) maxTokens = tot
      totalTokens += tot
      if (tot > 0) activeDays += 1
      cells.push({
        day: k,
        week: Math.floor(i / 7),
        weekday: d.getDay(),
        totalTokens: tot,
        calls: hit === undefined ? 0 : hit.calls,
        level: 0, // 稍后按 maxTokens 归一
        isFuture: k > today,
      })
    }
    // 分桶到 0..4 级：0 为空，1-4 按对数分布，避免单日峰值把其余日子压成同一级
    for (const c of cells) {
      if (c.totalTokens <= 0) {
        c.level = 0
      } else if (maxTokens <= 0) {
        c.level = 1
      } else {
        const ratio = c.totalTokens / maxTokens
        c.level = ratio > 0.5 ? 4 : ratio > 0.2 ? 3 : ratio > 0.05 ? 2 : 1
      }
    }

    return { cells, weeks, maxTokens, totalTokens, activeDays }
  }
}

/**
 * 在 `harnessHome` 下构造账本。会话根固定为 `<home>/sessions`。
 * @param {string} harnessHome DSH 的 harness home
 */
export function createLedger(harnessHome) {
  return new SessionLedger(path.join(harnessHome, 'sessions'))
}
