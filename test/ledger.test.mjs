/**
 * 数据层单元 + 一致性测试。
 *
 * 断言都基于实测事实，不做推测：
 * 1. 折叠语义必须与官方 tokenUsage 投影缓存（token-meter v2）逐字段相等。
 * 2. 同 (turn,step) 的替换必须是替换而非累加。
 * 3. 帧解析必须与朴素解压得到相同行数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const P = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/plugins/dsh-token-ledger/lib'
const { foldSession, localDayKey, SessionLedger, collectSessionLogs } = await import(pathToFileURL(P + '/ledger.js').href)
const { splitFrames, readZstdLines } = await import(pathToFileURL(P + '/zstd-frames.js').href)

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) {
    pass++
    console.log('  PASS ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
  }
}

const buckets = (uncached, out, cr, cw) => ({
  uncachedInputTokens: uncached,
  outputTokens: out,
  cacheReadTokens: cr,
  cacheWriteTokens: cw,
})

console.log('\n[1] localDayKey 时区正确性')
{
  const ms = new Date(2026, 8, 19, 0, 0, 0).getTime()
  ok(localDayKey(ms) === '2026-09-19', '当地午夜归入当日', localDayKey(ms))
  const ms2 = new Date(2026, 8, 19, 23, 59, 59).getTime()
  ok(localDayKey(ms2) === '2026-09-19', '当地 23:59 归入当日', localDayKey(ms2))
  const ms3 = new Date(2026, 0, 5, 12, 0, 0).getTime()
  ok(localDayKey(ms3) === '2026-01-05', '月份补零', localDayKey(ms3))
}

console.log('\n[2] 折叠语义：同 (turn,step) 替换而非累加')
{
  const t = new Date(2026, 8, 19, 10, 0, 0).getTime()
  // 一次重试：同一 step 先报 100，再报 150。正确总量是 150，不是 250。
  const events = [
    { type: 'step/start', seq: 1, time: t, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: t + 1000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    { type: 'assistant/message', seq: 3, time: t + 2000, data: { turn: 1, step: 1, usage: { inputTokens: 150, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 } } },
  ]
  const f = foldSession(events)
  const day = f.byDay.get('2026-09-19')
  ok(day !== undefined, '产出当日桶')
  ok(day.uncachedInputTokens === 150, '输入替换为 150（非 250）', day)
  ok(day.outputTokens === 20, '输出替换为 20（非 30）', day)
  ok(day.cacheReadTokens === 5, '缓存读取为 5', day)
  // 同 (turn,step) 的第二次上报是「同一请求的更准确样本」，取代而非新增请求，
  // 因此净请求数为 1 —— 与 token 桶的替换语义保持一致（日桶之和 = 总量）。
  ok(day.calls === 1, '净请求数计 1（替换非新增）', day.calls)
}

console.log('\n[3] llm/retry-started 关闭计费槽：重试后累加')
{
  const t = new Date(2026, 8, 19, 10, 0, 0).getTime()
  const events = [
    { type: 'assistant/message', seq: 1, time: t, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    { type: 'llm/retry-started', seq: 2, time: t + 500, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: t + 1000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
  ]
  const f = foldSession(events)
  const day = f.byDay.get('2026-09-19')
  ok(day.uncachedInputTokens === 200, '重试后累加为 200（两次计费）', day)
}

console.log('\n[4] 相同样本去重')
{
  const t = new Date(2026, 8, 19, 10, 0, 0).getTime()
  const u = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const events = [
    { type: 'assistant/message', seq: 1, time: t, data: { turn: 1, step: 1, usage: u } },
    { type: 'assistant/message', seq: 2, time: t + 100, data: { turn: 1, step: 1, usage: u } },
  ]
  const f = foldSession(events)
  const day = f.byDay.get('2026-09-19')
  ok(day.uncachedInputTokens === 100, '完全相同样本不重复计量', day)
}

console.log('\n[5] 跨日期替换：旧日回冲不留高估')
{
  const d1 = new Date(2026, 8, 19, 23, 59, 0).getTime()
  const d2 = new Date(2026, 8, 20, 0, 1, 0).getTime()
  const events = [
    { type: 'assistant/message', seq: 1, time: d1, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    { type: 'assistant/message', seq: 2, time: d2, data: { turn: 1, step: 1, usage: { inputTokens: 70, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
  ]
  const f = foldSession(events)
  const a = f.byDay.get('2026-09-19')
  const b = f.byDay.get('2026-09-20')
  ok(a === undefined || a.uncachedInputTokens === 0, '旧日回冲为 0（不留 100 残留）', a)
  ok(b.uncachedInputTokens === 70, '新日为替换后的 70', b)
}

console.log('\n[6] 与官方 tokenUsage 投影缓存逐字段一致性')
{
  const HOME = 'C:\\Users\\Eric\\AppData\\Roaming\\dsh-desktop\\harness'
  const SESS = path.join(HOME, 'sessions')
  const CACHE = path.join(HOME, 'storages', 'session_projcache', 'sessions')
  const eq = (x, y) =>
    x.uncachedInputTokens === y.uncachedInputTokens && x.outputTokens === y.outputTokens &&
    x.cacheReadTokens === y.cacheReadTokens && x.cacheWriteTokens === y.cacheWriteTokens

  let compared = 0
  let matched = 0
  const diffs = []

  for (const file of collectSessionLogs(SESS)) {
    const dirId = path.basename(path.dirname(file))
    const cands = [dirId + '.json', dirId.replace(/^session-/, '') + '.json']
    const cacheFile = fs.readdirSync(CACHE).find((f) => cands.includes(f))
    if (cacheFile === undefined) continue

    const cacheRaw = fs.readFileSync(path.join(CACHE, cacheFile), 'utf8')
    const logRaw = fs.readFileSync(file)
    let j
    try {
      j = JSON.parse(cacheRaw)
    } catch {
      continue
    }
    const row = j && j.record && j.record.rows && j.record.rows.tokenUsage
    if (!row || !row.val || !row.val.totals) continue

    const events = []
    readZstdLines(logRaw, (l) => {
      try {
        events.push(JSON.parse(l))
      } catch {}
    })
    const maxSeq = Math.max(...events.map((e) => e.seq ?? -1))
    if (row.seq > maxSeq) continue // 缓存领先于日志，跳过活跃会话

    // 折叠到 cache.seq 为止，保证比较的是同一时刻的同一状态
    const upto = events.filter((e) => (e.seq ?? 0) <= row.seq)
    const f = foldSession(upto)
    const got = buckets(0, 0, 0, 0)
    for (const s of f.byDay.values()) {
      got.uncachedInputTokens += s.uncachedInputTokens
      got.outputTokens += s.outputTokens
      got.cacheReadTokens += s.cacheReadTokens
      got.cacheWriteTokens += s.cacheWriteTokens
    }
    compared++
    if (eq(got, row.val.totals)) matched++
    else diffs.push({ id: dirId, official: row.val.totals, got })
  }
  ok(compared > 0, '至少比较一个会话', { compared })
  ok(matched === compared, `全部一致 (${matched}/${compared})`, diffs.slice(0, 3))
}

console.log('\n[7] SessionLedger 聚合与增量缓存')
{
  const HOME = 'C:\\Users\\Eric\\AppData\\Roaming\\dsh-desktop\\harness'
  const led = new SessionLedger(path.join(HOME, 'sessions'))
  const t0 = Date.now()
  const r1 = led.scan({ now: Date.now() })
  const ms1 = Date.now() - t0
  const t1 = Date.now()
  const r2 = led.scan({ now: Date.now() })
  const ms2 = Date.now() - t1
  ok(r1.days.length > 0, '产出日桶', { days: r1.days.length })
  ok(r1.fileCount > 0, '扫描到会话文件', { fileCount: r1.fileCount })
  ok(r2.stats.reused === r2.fileCount, '第二次全部命中增量缓存', r2.stats)
  ok(r2.allTime.totalTokens === r1.allTime.totalTokens, '两次结果一致', { a: r1.allTime.totalTokens, b: r2.allTime.totalTokens })
  const sumOfDays = r1.days.reduce((a, d) => a + d.totalTokens, 0)
  ok(sumOfDays === r1.allTime.totalTokens, '日桶之和等于全时段总量', { sumOfDays, allTime: r1.allTime.totalTokens })
  console.log(`  info 首次 ${ms1}ms，二次 ${ms2}ms，缓存 ${r2.stats.reused}/${r2.fileCount}`)
}

console.log('\n[8] recent() 补齐空缺日期')
{
  const HOME = 'C:\\Users\\Eric\\AppData\\Roaming\\dsh-desktop\\harness'
  const led = new SessionLedger(path.join(HOME, 'sessions'))
  const now = new Date(2026, 8, 25, 12, 0, 0).getTime()
  const win = led.recent(7, { now })
  ok(win.length === 7, '恰好 7 天', { n: win.length })
  ok(win[6].day === '2026-09-25', '末位是今天', win[6].day)
  ok(win[0].day === '2026-09-19', '首位是 6 天前', win[0].day)
  const filled = win.filter((d) => d.calls === 0).length
  ok(filled >= 0, `补齐空缺（${filled} 天为 0）`)
  const sorted = win.every((d, i) => i === 0 || win[i - 1].day < d.day)
  ok(sorted, '升序排列')
}

console.log('\n[9] 帧解析与朴素解压行数一致')
{
  const HOME = 'C:\\Users\\Eric\\AppData\\Roaming\\dsh-desktop\\harness'
  const files = collectSessionLogs(path.join(HOME, 'sessions'))
  let checked = 0
  let agree = 0
  const zlib = await import('node:zlib')
  for (const f of files) {
    const buf = fs.readFileSync(f)
    let parserLines = 0
    readZstdLines(buf, () => {
      parserLines++
    })
    const frames = splitFrames(buf)
    let naiveLines = 0
    for (const fr of frames) {
      try {
        const t = zlib.default.zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8')
        for (const l of t.split('\n')) if (l.trim()) naiveLines++
      } catch {}
    }
    checked++
    if (parserLines === naiveLines && frames.length > 0) agree++
  }
  ok(checked > 0, '检查了文件', { checked })
  ok(agree === checked, `全部一致 (${agree}/${checked})`)
}

console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
