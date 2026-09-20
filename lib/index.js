/**
 * dsh-token-ledger（Token 账本）— 宿主侧插件。
 *
 * 监控 DSH 每日 token 消耗：从会话日志重建 provider 上报用量，按本地日期聚合，
 * 通过 HTTP 路由 + 聊天命令 + 模型工具三种方式暴露。
 *
 * 设计取舍：
 * - 数据源是会话日志而非投影缓存。缓存只覆盖「曾被加载过」的会话，且会落后于
 *   日志尾部；日志是权威且完整的。折叠语义与官方 tokenUsage 投影逐字节一致
 *   （已实测：20/20 会话与官方缓存精确相等）。
 * - 零 peer 依赖：不 import 任何 @deepseek-ai/* 包，只用 node: 内置模块与原始
 *   JSON-Schema 工具定义，避免插件与宿主版本耦合。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLedger, localDayKey } from './ledger.js'

/** 路由前缀。所有端点都挂在这下面，便于一次性注册与卸载。 */
const ROUTE_PREFIX = '/dsh-token-ledger'

/**
 * 解析 DSH 的 harness home。
 * 桌面版在 spawn 宿主进程时显式设置 `DSH_HOME`，因此环境变量是第一权威；
 * 显式配置其次；`~/.dsh` 是最终回退（与 @deepseek-ai/dsh-home-paths 同序）。
 * @param {string|undefined} configured 插件配置里的显式路径
 * @returns {string} 绝对路径
 */
function resolveHarnessHome(configured) {
  const fromConfig = typeof configured === 'string' ? configured.trim() : ''
  if (fromConfig.length > 0) return path.resolve(fromConfig.replace(/^~(?=$|[\\/])/, os.homedir()))
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 数字千分位，便于阅读大数值。 */
const fmt = (n) => Number(n || 0).toLocaleString('en-US')

/** 紧凑记法：1.23M / 45.6K，用于徽标等窄空间。 */
function compact(n) {
  const v = Number(n || 0)
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return String(Math.round(v))
}

/** 发送 JSON 响应。 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * 汇总报告附带的派生字段（缓存命中率、缓存节省占比）。
 *
 * 命中率定义：cacheRead / (uncachedInput + cacheRead)。
 * 这是「请求侧有多少输入命中了缓存」，与 DSH 客户端自身的口径一致。
 * @param {object} row 含四桶的行
 */
function decorate(row) {
  const prompt = row.uncachedInputTokens + row.cacheReadTokens + row.cacheWriteTokens
  return {
    ...row,
    promptTokens: prompt,
    cacheHitRate: prompt === 0 ? 0 : row.cacheReadTokens / prompt,
    totalTokens:
      row.uncachedInputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
  }
}

/** 把聚合报告整理成前端与命令共用的形状。 */
function buildPayload(ledger, days, opts = {}) {
  const report = ledger.scan(opts)
  const window = ledger.recent(days, { now: report.generatedAt, force: false })
  const heatmapWeeks = Number.isInteger(opts.heatmapWeeks)
    ? Math.min(104, Math.max(4, opts.heatmapWeeks))
    : 52
  return {
    ok: true,
    generatedAt: report.generatedAt,
    today: report.today,
    days: window.map(decorate),
    recentTotals: (() => {
      const acc = {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 0,
        sessions: 0,
      }
      for (const d of window) {
        acc.uncachedInputTokens += d.uncachedInputTokens
        acc.outputTokens += d.outputTokens
        acc.cacheReadTokens += d.cacheReadTokens
        acc.cacheWriteTokens += d.cacheWriteTokens
        acc.calls += d.calls
        acc.sessions += d.sessions
      }
      return decorate(acc)
    })(),
    allTime: decorate(report.allTime),
    models: report.models.map(decorate),
    tools: report.tools,
    breakdown: report.breakdown.map(decorate),
    sessions: report.sessions.map((s) => ({
      id: s.id,
      workspace: s.workspace,
      title: s.title,
      ...decorate(s.totals),
      calls: s.calls,
      turns: s.turns,
      userMessages: s.userMessages,
      firstTime: s.firstTime,
      lastTime: s.lastTime,
      spanMs: s.spanMs,
      wallSpanMs: s.wallSpanMs,
    })),
    metrics: report.metrics,
    heatmap: ledger.heatmap(heatmapWeeks, { now: report.generatedAt, force: false }),
    sessionCount: report.sessionCount,
    fileCount: report.fileCount,
    stats: report.stats,
  }
}

/** 生成 CSV（含 BOM，便于 Excel 直接打开中文表头）。 */
function toCsv(payload) {
  const head = ['日期', '未缓存输入', '输出', '缓存读取', '缓存写入', '总Token', '缓存命中率', '请求数', '会话数']
  const lines = [head.join(',')]
  for (const d of payload.days) {
    lines.push([
      d.day,
      d.uncachedInputTokens,
      d.outputTokens,
      d.cacheReadTokens,
      d.cacheWriteTokens,
      d.totalTokens,
      (d.cacheHitRate * 100).toFixed(2) + '%',
      d.calls,
      d.sessions,
    ].join(','))
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

/** 命令输出：把最近 N 天渲染成固定宽度的文本表（最新一行在最上方）。 */
function renderTable(payload, days) {
  const pad = (s, n, right) => {
    const str = String(s)
    return right ? str.padStart(n) : str.padEnd(n)
  }
  // payload.days 是升序（图表友好）；终端阅读习惯是「最近的在最上面」。
  const rows = payload.days.slice().reverse()
  const out = []
  out.push(`Token 账本  今日 ${payload.today}  窗口 ${days} 天`)
  out.push('')
  out.push(
    pad('日期', 12) + pad('未缓存输入', 12, true) + pad('缓存读取', 13, true) + pad('输出', 11, true) + pad('合计', 13, true) + pad('命中率', 9, true) + pad('请求', 7, true)
  )
  out.push('-'.repeat(77))
  for (const d of rows) {
    out.push(
      pad(d.day, 12) +
        pad(fmt(d.uncachedInputTokens), 12, true) +
        pad(fmt(d.cacheReadTokens), 13, true) +
        pad(fmt(d.outputTokens), 11, true) +
        pad(fmt(d.totalTokens), 13, true) +
        pad((d.cacheHitRate * 100).toFixed(1) + '%', 9, true) +
        pad(fmt(d.calls), 7, true)
    )
  }
  out.push('-'.repeat(77))
  const rt = payload.recentTotals
  out.push(
    pad(`合计(${days}天)`, 12) +
      pad(fmt(rt.uncachedInputTokens), 12, true) +
      pad(fmt(rt.cacheReadTokens), 13, true) +
      pad(fmt(rt.outputTokens), 11, true) +
      pad(fmt(rt.totalTokens), 13, true) +
      pad((rt.cacheHitRate * 100).toFixed(1) + '%', 9, true) +
      pad(fmt(rt.calls), 7, true)
  )
  out.push('')
  const at = payload.allTime
  out.push(`全时段：合计 ${fmt(at.totalTokens)}  token（未缓存输入 ${fmt(at.uncachedInputTokens)} / 缓存读取 ${fmt(at.cacheReadTokens)} / 输出 ${fmt(at.outputTokens)}）`)
  out.push(`覆盖 ${payload.sessionCount} 个会话，缓存命中率 ${(at.cacheHitRate * 100).toFixed(1)}%`)

  // 仪表盘指标（对应「累计/峰值/最长时长/连续天数/最常用工具」）
  const M = payload.metrics
  if (M !== undefined) {
    out.push('')
    out.push('总览：')
    out.push(`  累计 Token      ${fmt(M.cumulativeTokens)}`)
    out.push(`  峰值 Token      ${fmt(M.peakTokens)}${M.peakDay === null ? '' : `（${M.peakDay}）`}`)
    out.push(`  最长聊天时长    ${fmtDuration(M.longestSessionMs)}`)
    out.push(`  当前连续天数    ${M.currentStreak} 天`)
    out.push(`  最长连续天数    ${M.longestStreak} 天（活跃 ${M.activeDayCount} 天）`)
    out.push(`  轮次 / 用户消息 ${fmt(M.totalTurns)} / ${fmt(M.totalUserMessages)}`)
    out.push(
      `  工具调用        ${fmt(M.totalToolCalls)} 次，失败 ${fmt(M.totalToolErrors)} 次` +
        (M.topTool === null ? '' : `；最常用 ${M.topTool}（${fmt(M.topToolCalls)} 次）`)
    )
  }

  if (payload.tools !== undefined && payload.tools.length > 0) {
    out.push('')
    out.push('最常用的工具（全时段 Top 10）：')
    for (const t of payload.tools.slice(0, 10)) {
      out.push(
        `  ${t.name.padEnd(20)} ${String(fmt(t.calls)).padStart(7)} 次   成功率 ${(t.successRate * 100).toFixed(1)}%`
      )
    }
  }

  if (payload.models.length > 0) {
    out.push('')
    out.push('按模型（全时段）：')
    for (const m of payload.models.slice(0, 10)) {
      out.push(`  ${m.provider}${m.provider ? '/' : ''}${m.model}  合计 ${fmt(m.totalTokens)}  请求 ${fmt(m.calls)}`)
    }
  }
  return out.join('\n')
}

/**
 * 把毫秒渲染成人类可读时长（中文）。
 * @param {number} ms 毫秒
 * @returns {string} 如「3 小时 50 分」「12 分 3 秒」
 */
function fmtDuration(ms) {
  const v = Number(ms) || 0
  if (v <= 0) return '0 分'
  const totalSec = Math.round(v / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
  return `${s} 秒`
}

/**
 * 插件配置。
 *
 * 刻意保持极简：只要一个可选的 root 覆盖。其余字段一律拒绝，避免拼写错误
 * 被静默默认值掩盖（沿用宿主其它插件校验配置键的做法）。
 * @param {object} config
 */
function normalizeConfig(config) {
  if (config === undefined || config === null) return {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('token-ledger: config must be an object')
  }
  const allowed = new Set(['root', 'cacheTtlMs', 'enabled'])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new Error(`token-ledger: unknown config key "${key}"`)
  }
  return config
}

/**
 * 插件入口用的账本持有者：带 TTL 的惰性扫描。
 *
 * 扫描本身有增量缓存（按文件 mtime+size 复用），但徽标轮询会频繁触发，
 * 这里再加一层短 TTL，避免每秒都去 stat 整个会话库。
 */
class LedgerHolder {
  /**
   * @param {string} root harness home
   * @param {number} ttlMs 结果缓存时长
   */
  constructor(root, ttlMs) {
    this.ledger = createLedger(root)
    this.root = root
    this.ttlMs = ttlMs
    this._last = null
    this._lastAt = 0
  }

  /**
   * 取报告，TTL 内复用。
   * @param {number} days 窗口天数
   * @param {boolean} force 跳过 TTL
   * @param {number} [heatmapWeeks] 热力图周数（列数）
   */
  get(days, force = false, heatmapWeeks) {
    const now = Date.now()
    if (
      !force &&
      this._last !== null &&
      this._last.days === days &&
      this._last.heatmapWeeks === heatmapWeeks &&
      now - this._lastAt < this.ttlMs
    ) {
      return this._last.payload
    }
    const payload = buildPayload(this.ledger, days, { now, force, heatmapWeeks })
    this._last = { days, payload, heatmapWeeks }
    this._lastAt = now
    return payload
  }
}

/** 插件名。 */
export const name = 'dsh-token-ledger'

/**
 * 本插件 fiber 不强制依赖任何服务。
 *
 * webServer / commands / tools 都是可选的：每一面各自通过
 * `ctx.inject([...], cb)` 建立子 fiber，服务缺席时只是那一面不注册，
 * 既不会阻塞本插件激活，也不会让 profile 启动失败。
 *
 * 必须这样写而不能直接读 `ctx.tools`：Cordis 的 ctx 是 Proxy，
 * 访问未在 inject 中声明的服务属性会**立即抛错**
 * （`cannot get property "x" without inject`），回头再判 undefined 已经晚了。
 */
export const inject = []

/**
 * 注册插件：HTTP 路由、聊天命令、模型工具。
 * @param {object} ctx Cordis 上下文
 * @param {object} rawConfig 插件配置
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const root = resolveHarnessHome(config.root)
  const ttlMs = Number.isFinite(config.cacheTtlMs) && config.cacheTtlMs >= 0 ? config.cacheTtlMs : 5000
  const holder = new LedgerHolder(root, ttlMs)
  const enabled = config.enabled !== false

  // ctx.logger 是 Cordis 内置服务，但同样受 Proxy 约束：用 try 包住，
  // 日志失败绝不能影响插件加载。
  const log = (level, ...args) => {
    try {
      const logger = ctx.logger
      const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null
      if (fn !== null) fn('[token-ledger]', ...args)
    } catch {
      // 日志不可用不是错误；静默继续。
    }
  }

  if (!enabled) {
    log('info', 'disabled by config')
    return
  }

  log('info', `harness home = ${root}`)

  const parseDays = (raw, fallback) => {
    const n = Number.parseInt(String(raw ?? ''), 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(3650, Math.max(1, n))
  }

  const parseWeeks = (raw, fallback) => {
    const n = Number.parseInt(String(raw ?? ''), 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(104, Math.max(4, n))
  }

  // ── HTTP 路由（Web UI 卡片消费）────────────────────────────────
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const dispose = host.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          const url = new URL(request.url || '/', 'http://127.0.0.1')
          const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'

          try {
            if (sub === '/api/summary' || sub === '/') {
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' })
                response.end()
                return
              }
              const days = parseDays(url.searchParams.get('days'), 30)
              const weeks = parseWeeks(url.searchParams.get('weeks'), 52)
              sendJson(response, 200, holder.get(days, url.searchParams.get('force') === '1', weeks))
              return
            }

            if (sub === '/api/refresh') {
              if (request.method !== 'POST') {
                response.writeHead(405, { allow: 'POST' })
                response.end()
                return
              }
              const days = parseDays(url.searchParams.get('days'), 30)
              const weeks = parseWeeks(url.searchParams.get('weeks'), 52)
              sendJson(response, 200, holder.get(days, true, weeks))
              return
            }

            if (sub === '/api/export.csv') {
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' })
                response.end()
                return
              }
              const days = parseDays(url.searchParams.get('days'), 90)
              const csv = toCsv(holder.get(days, false, 52))
              response.writeHead(200, {
                'content-type': 'text/csv; charset=utf-8',
                'content-disposition': `attachment; filename="dsh-token-ledger-${localDayKey(Date.now())}.csv"`,
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(csv),
              })
              response.end(csv)
              return
            }

            if (sub === '/api/health') {
              sendJson(response, 200, {
                ok: true,
                root,
                sessionsRoot: holder.ledger.sessionsRoot,
                sessionsRootExists: fs.existsSync(holder.ledger.sessionsRoot),
                ttlMs,
              })
              return
            }

            sendJson(response, 404, { ok: false, error: `unknown endpoint ${sub}` })
          } catch (error) {
            log('error', 'route failed:', String(error && error.stack ? error.stack : error))
            sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      }, 'token-ledger: api')
      return dispose
    })
  })

  // ── 聊天命令 ──────────────────────────────────────────────────
  // 同样用 inject 声明依赖，避免依赖加载顺序（服务就绪后子 fiber 才激活）。
  ctx.inject(['commands'], (sub) => {
    sub.effect(() =>
      sub.commands.register({
        name: 'tokens',
        description: 'Token 账本：查看每日 token 消耗（今日/近N日/模型拆分/CSV 导出）',
        input: { hint: '[days] | csv [days] | today | help' },
        handler: async (invocation) => {
          try {
            const raw = String(invocation && invocation.rawInput ? invocation.rawInput : '').trim()
            const parts = raw.length === 0 ? [] : raw.split(/\s+/)
            const head = (parts[0] || '').toLowerCase()

            if (head === 'help') {
              return {
                kind: 'success',
                text: [
                  'Token 账本用法：',
                  '  /tokens            近 7 天日报表',
                  '  /tokens 30         近 30 天',
                  '  /tokens today      只看今日',
                  '  /tokens csv [days] 导出 CSV（写入 harness home）',
                  '  /tokens help       本帮助',
                  '',
                  '网页端：设置 → Token 账本；输入框下方徽标显示今日用量。',
                ].join('\n'),
              }
            }

            if (head === 'csv') {
              const days = parseDays(parts[1], 90)
              const payload = holder.get(days, true)
              const file = path.join(root, `token-ledger-${localDayKey(Date.now())}-${days}d.csv`)
              fs.writeFileSync(file, toCsv(payload), 'utf8')
              return { kind: 'success', text: `已导出 ${payload.days.length} 天数据：\n${file}` }
            }

            if (head === 'today') {
              const payload = holder.get(7, true)
              const t = payload.days.find((d) => d.day === payload.today)
              if (t === undefined) {
                return { kind: 'success', text: `今日（${payload.today}）暂无 token 记录。` }
              }
              return {
                kind: 'success',
                text: [
                  `今日 ${t.day}`,
                  `  未缓存输入  ${fmt(t.uncachedInputTokens)}`,
                  `  缓存读取    ${fmt(t.cacheReadTokens)}`,
                  `  输出        ${fmt(t.outputTokens)}`,
                  `  合计        ${fmt(t.totalTokens)}`,
                  `  缓存命中率  ${(t.cacheHitRate * 100).toFixed(1)}%`,
                  `  请求数      ${fmt(t.calls)}`,
                ].join('\n'),
              }
            }

            const days = parseDays(parts[0], 7)
            return { kind: 'success', text: renderTable(holder.get(days, true), days) }
          } catch (error) {
            return { kind: 'error', text: `Token 账本查询失败：${String(error && error.message ? error.message : error)}` }
          }
        },
      })
    )
    log('info', 'command /tokens registered')
  })

  // ── 模型工具 ──────────────────────────────────────────────────
  // 用 inject 声明依赖：tools 服务缺席时这一面安静跳过，而不是抛错。
  ctx.inject(['tools'], (sub) => {
    sub.tools.register({
      name: 'token_usage',
      description:
        '查询本机 DSH 的 token 消耗账本：按本地日期聚合的 provider 上报用量（未缓存输入/缓存读取/输出），含累计/峰值 token、最长聊天时长、连续天数、最常用工具、模型与工具拆分。用于回答「今天用了多少 token」「最近一周消耗趋势」「最常用什么工具」等问题。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: {
            type: 'integer',
            minimum: 1,
            maximum: 3650,
            description: '统计窗口天数（默认 7）。',
          },
          includeSessions: {
            type: 'boolean',
            description: '是否附带消耗最高的会话明细（默认 false）。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
      },
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const days = Number.isInteger(a.days) ? Math.min(3650, Math.max(1, a.days)) : 7
        const payload = holder.get(days, true)
        const text = renderTable(payload, days)
        if (a.includeSessions === true) {
          const lines = ['', '按会话（Top 10）：']
          for (const s of payload.sessions.slice(0, 10)) {
            const title = s.title === null || s.title === undefined ? '' : `  「${String(s.title).slice(0, 24)}」`
            lines.push(
              `  ${s.id}  合计 ${fmt(s.totalTokens)}  请求 ${fmt(s.calls)}  时长 ${fmtDuration(s.spanMs)}${title}`
            )
          }
          return { text: text + lines.join('\n') }
        }
        return { text }
      },
    })
    log('info', 'tool token_usage registered')
  })
}
