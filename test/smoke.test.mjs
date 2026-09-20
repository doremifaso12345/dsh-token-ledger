/**
 * 插件冒烟测试：用模拟 Cordis 上下文加载宿主半，验证
 * 1. apply() 不抛异常、配置校验正确
 * 2. HTTP 路由注册并能正确响应（含 405/404 分支）
 * 3. 聊天命令返回合法 CommandResult
 * 4. 模型工具 execute 返回文本
 *
 * 注意：替身 inject 必须模拟 Cordis 的真实语义——插件用
 * `ctx.inject(['x'], cb)` 声明依赖，服务缺席时 cb 不执行（而非抛错）。
 * 早期版本的替身只在 deps 含 webServer 时回调，导致 apply 中途返回、
 * 三面注册不全却"看起来"通过。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const P = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/plugins/dsh-token-ledger/lib/index.js'
const mod = await import(pathToFileURL(P).href)

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

/**
 * 最小 Cordis 上下文替身：记录注册项，支持 inject/effect/get/logger。
 * `services` 决定哪些服务可见（模拟服务缺席）。
 */
function fakeCtx(services = ['webServer', 'commands', 'tools']) {
  const routes = []
  const commands = []
  const tools = []
  const has = (n) => services.includes(n)
  const childOf = () => fakeCtx(services)

  const ctx = {
    _routes: routes,
    _commands: commands,
    _tools: tools,
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    // 声明式依赖：deps 全部可用时才回调；与真实 Cordis 语义一致
    inject: (deps, fn) => {
      const list = Array.isArray(deps) ? deps : Object.keys(deps)
      if (!list.every(has)) return
      const sub = childOf()
      // 子 fiber 上通过属性访问已声明的服务
      for (const name of list) {
        if (name === 'webServer') sub.webServer = { register: (r) => { routes.push(r); return () => {} } }
        if (name === 'commands') sub.commands = { register: (d) => { commands.push(d); return () => {} } }
        if (name === 'tools') sub.tools = { register: (t) => { tools.push(t); return () => {} } }
      }
      fn(sub)
    },
    get: (n) => (has(n) && n === 'commands' ? { register: (def) => commands.push(def) } : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return ctx
}

/** 极简 req/res 替身。 */
function fakeHttp(method, url, body) {
  let status = 0
  let headers = null
  let payload = ''
  const response = {
    writeHead: (s, hh) => {
      status = s
      headers = hh || null
    },
    end: (b) => {
      payload = b === undefined ? '' : String(b)
    },
  }
  const request = { method, url, headers: { host: '127.0.0.1:43129' }, on: () => {}, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(body) } }
  return { request, response, read: () => ({ status, headers, payload }) }
}

console.log('\n[1] 模块导出契约')
ok(mod.name === 'dsh-token-ledger', '插件 name 正确', mod.name)
ok(typeof mod.apply === 'function', 'apply 是函数')
ok(Array.isArray(mod.inject), 'inject 是数组', mod.inject)

console.log('\n[2] 配置校验')
{
  const ctx = fakeCtx()
  let threw = null
  try {
    mod.apply(ctx, { bogusKey: 1 })
  } catch (e) {
    threw = String(e.message)
  }
  ok(threw !== null && threw.includes('unknown config key'), '未知配置键被拒绝', threw)
}
{
  const ctx = fakeCtx()
  let threw = null
  try {
    mod.apply(ctx, 'not-an-object')
  } catch (e) {
    threw = String(e.message)
  }
  ok(threw !== null, '非对象配置被拒绝', threw)
}

console.log('\n[3] apply 注册三面：路由 / 命令 / 工具')
const ctx = fakeCtx()
mod.apply(ctx, { enabled: true, cacheTtlMs: 0 })
ok(ctx._routes.length === 1, '注册了 1 条 HTTP 路由', ctx._routes.length)
ok(ctx._routes[0].kind === 'prefix', '路由是 prefix 类型', ctx._routes[0] && ctx._routes[0].kind)
ok(ctx._routes[0].path === '/dsh-token-ledger', '路由前缀正确', ctx._routes[0] && ctx._routes[0].path)
ok(ctx._commands.length === 1, '注册了 /tokens 命令', ctx._commands.length)
ok(ctx._commands[0] && ctx._commands[0].name === 'tokens', '命令名是 tokens', ctx._commands[0] && ctx._commands[0].name)
ok(ctx._tools.length === 1, '注册了 token_usage 工具', ctx._tools.length)
ok(ctx._tools[0] && ctx._tools[0].name === 'token_usage', '工具名正确', ctx._tools[0] && ctx._tools[0].name)

console.log('\n[4] enabled:false 时静默跳过')
{
  const c2 = fakeCtx()
  mod.apply(c2, { enabled: false })
  ok(c2._routes.length === 0 && c2._commands.length === 0 && c2._tools.length === 0, '禁用时不注册任何面')
}

console.log('\n[4b] 服务缺席时必须不抛异常（原启动故障的回归防线）')
{
  // 逐个服务缺席组合；任一组合抛错都会让整个 profile 启动失败。
  const combos = [
    [],
    ['tools'],
    ['commands'],
    ['webServer'],
    ['webServer', 'commands'],
    ['webServer', 'tools'],
    ['commands', 'tools'],
  ]
  for (const services of combos) {
    const c = fakeCtx(services)
    let threw = null
    try {
      mod.apply(c, { enabled: true, cacheTtlMs: 0 })
    } catch (e) {
      threw = e
    }
    const label = services.length === 0 ? '全缺席' : services.join('+')
    ok(threw === null, `服务可用的只有 [${label}] 时不抛异常`, threw === null ? undefined : String(threw.message))
  }
}

console.log('\n[5] HTTP 路由行为')
const route = ctx._routes[0]
async function call(method, sub) {
  const h = fakeHttp(method, '/dsh-token-ledger' + sub)
  await route.handler(h.request, h.response)
  return h.read()
}

{
  const r = await call('GET', '/api/health')
  ok(r.status === 200, 'health 200', r.status)
  const j = JSON.parse(r.payload)
  ok(j.ok === true, 'health ok:true')
  ok(typeof j.sessionsRoot === 'string' && j.sessionsRoot.includes('sessions'), 'sessionsRoot 指向 sessions 目录', j.sessionsRoot)
  ok(j.sessionsRootExists === true, 'sessions 目录存在', j.sessionsRootExists)
}

{
  const r = await call('GET', '/api/summary?days=7')
  ok(r.status === 200, 'summary 200', r.status)
  const j = JSON.parse(r.payload)
  ok(j.ok === true, 'summary ok:true')
  ok(Array.isArray(j.days) && j.days.length === 7, '返回 7 天', j.days && j.days.length)
  ok(j.days.every((d) => typeof d.day === 'string' && typeof d.totalTokens === 'number'), '每天有 day/totalTokens')
  ok(typeof j.recentTotals.totalTokens === 'number', '有窗口合计')
  ok(typeof j.allTime.totalTokens === 'number', '有全时段合计')
  ok(typeof j.today === 'string', '有 today')
  ok(Array.isArray(j.models), '有 models 数组')
  // 契约：API 返回**升序**（时间轴顺序，便于直接画图）；终端表格由 renderTable 反转。
  const sortedAsc = j.days.every((d, i) => i === 0 || j.days[i - 1].day < d.day)
  ok(sortedAsc, 'summary 按日期升序（时间轴）', j.days.map((d) => d.day))
}

{
  const r = await call('GET', '/api/summary?days=3')
  const j = JSON.parse(r.payload)
  ok(j.days.length === 3, 'days 参数生效', j.days.length)
}

{
  const r = await call('GET', '/api/summary?days=99999')
  const j = JSON.parse(r.payload)
  ok(j.days.length <= 3650, 'days 上限被钳制', j.days.length)
}

{
  const r = await call('GET', '/api/summary?days=abc')
  ok(r.status === 200, '非法 days 回退默认而非报错', r.status)
}

{
  const r = await call('GET', '/api/export.csv?days=7')
  ok(r.status === 200, 'csv 200', r.status)
  ok(r.payload.startsWith('\ufeff'), 'CSV 带 BOM（Excel 友好）')
  const lines = r.payload.split('\r\n')
  ok(lines.length >= 2, 'CSV 至少表头+1行', lines.length)
  ok(lines[0].includes('日期') && lines[0].includes('总Token'), 'CSV 表头正确', lines[0])
  ok(r.headers['content-type'].includes('text/csv'), 'CSV content-type 正确', r.headers['content-type'])
  ok(r.headers['content-disposition'].includes('attachment'), 'CSV 触发下载')
  // 数据行字段数应与表头一致
  const hdrCols = lines[0].split(',').length
  const bodyOk = lines.slice(1).filter((l) => l.length > 0).every((l) => l.split(',').length === hdrCols)
  ok(bodyOk, 'CSV 每行列数与表头一致', { hdrCols })
}

{
  const r = await call('POST', '/api/refresh?days=7')
  ok(r.status === 200, 'refresh 200', r.status)
}

{
  const r = await call('GET', '/api/refresh')
  ok(r.status === 405, 'GET /refresh 返回 405', r.status)
  ok(String(r.headers.allow).includes('POST'), '405 带 allow:POST', r.headers.allow)
}

{
  const r = await call('POST', '/api/summary')
  ok(r.status === 405, 'POST /summary 返回 405', r.status)
}

{
  const r = await call('GET', '/api/nope')
  ok(r.status === 404, '未知端点 404', r.status)
  const j = JSON.parse(r.payload)
  ok(j.ok === false && typeof j.error === 'string', '404 返回结构化错误')
}

{
  const r = await call('GET', '/')
  ok(r.status === 200, '根路径映射到 summary', r.status)
}

console.log('\n[6] /tokens 命令')
const cmd = ctx._commands[0]
const run = async (raw) => cmd.handler({ rawInput: raw })

{
  const r = await run('')
  ok(r && r.kind === 'success', '空参数返回 success', r && r.kind)
  ok(typeof r.text === 'string' && r.text.length > 0, '有输出文本')
  ok(r.text.includes('Token 账本'), '标题正确')
  const dayLines = r.text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
  ok(dayLines.length === 7, '默认 7 天表格', dayLines.length)
  // 终端阅读顺序：最新日期在最上方
  ok(dayLines[0] > dayLines[dayLines.length - 1], '表格最新一行在最上方', [dayLines[0], dayLines[dayLines.length - 1]])
}
{
  const r = await run('30')
  const dayLines = r.text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
  ok(dayLines.length === 30, 'tokens 30 输出 30 行', dayLines.length)
}
{
  const r = await run('today')
  ok(r.kind === 'success', 'today 返回 success')
  ok(r.text.includes('今日') || r.text.includes('暂无'), 'today 输出合理', r.text.split('\n')[0])
}
{
  const r = await run('help')
  ok(r.kind === 'success' && r.text.includes('/tokens'), 'help 输出用法')
}
{
  const r = await run('csv 7')
  ok(r.kind === 'success', 'csv 返回 success', r.kind)
  ok(r.text.includes('.csv'), 'csv 给出文件路径', r.text)
}
{
  const r = await run('garbage-input')
  ok(r.kind === 'success' || r.kind === 'error', '非法输入仍返回合法 CommandResult', r.kind)
}
// 所有返回都必须是合法 kind
{
  const results = await Promise.all(['', 'today', 'help', '7'].map(run))
  ok(results.every((r) => r && (r.kind === 'success' || r.kind === 'error')), '所有结果都有合法 kind')
  ok(results.filter((r) => r.kind === 'success').every((r) => typeof r.text === 'string'), 'success 都带 string text')
}

console.log('\n[7] token_usage 工具')
const tool = ctx._tools[0]
{
  const r = await tool.execute({})
  ok(typeof r.text === 'string' && r.text.length > 0, '默认参数返回文本')
}
{
  const r = await tool.execute({ days: 3 })
  const dayLines = r.text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
  ok(dayLines.length === 3, 'days:3 输出 3 行', dayLines.length)
}
{
  const r = await tool.execute({ days: 7, includeSessions: true })
  ok(r.text.includes('按会话'), 'includeSessions 附带会话明细')
}
{
  const r = await tool.execute({ days: 99999 })
  ok(typeof r.text === 'string', '超大 days 不崩溃')
}
{
  const r = await tool.execute(null)
  ok(typeof r.text === 'string', 'null args 不崩溃')
}
{
  // 参数 schema 结构合法
  ok(tool.parameters.type === 'object', 'parameters 是 object schema')
  ok(tool.output && typeof tool.output.render === 'function', 'output.render 存在')
  const rendered = tool.output.render({}, { text: 'x' })
  ok(Array.isArray(rendered) && rendered[0].type === 'text', 'render 返回 text block', rendered)
}

console.log('\n[8] 数据真实性：报告里应含本机真实会话数据')
{
  const c3 = fakeCtx()
  mod.apply(c3, { enabled: true, cacheTtlMs: 0 })
  const h = fakeHttp('GET', '/dsh-token-ledger/api/summary?days=365')
  await c3._routes[0].handler(h.request, h.response)
  const j = JSON.parse(h.read().payload)
  ok(j.sessionCount > 0, '检出了本机会话', j.sessionCount)
  ok(j.fileCount > 0, '扫描了会话文件', j.fileCount)
  ok(j.allTime.totalTokens > 0, '全时段总量 > 0', j.allTime.totalTokens)
  const nonZeroDays = j.days.filter((d) => d.totalTokens > 0).length
  ok(nonZeroDays > 0, '存在有消耗的日期', nonZeroDays)
  console.log('  info 会话数=' + j.sessionCount + ' 文件数=' + j.fileCount + ' 全时段=' + j.allTime.totalTokens + ' token')
}

console.log(`\n===== 冒烟结果：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
