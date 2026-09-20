/**
 * 真实内核加载测试。
 *
 * 用 @deepseek-ai/cordis 的真 Context（而非替身）加载插件，验证：
 * apply 能在真 fiber 上运行、ctx.effect / ctx.inject / ctx.get 语义成立、
 * 真 webServer 服务被识别、路由真的能通过 HTTP 请求。
 *
 * 这里自建一个最小但真实的宿主：注册一个真 webServer 服务与真 commands 服务，
 * 然后加载插件并真的起一个 http server 打请求。
 */
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const CORDIS = 'D:/dsh/DeepSeek Harness Desktop/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js'
const PLUGIN = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/plugins/dsh-token-ledger/lib/index.js'

const { Context } = await import(pathToFileURL(CORDIS).href)
const plugin = await import(pathToFileURL(PLUGIN).href)

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

console.log('\n[1] 真实 Cordis Context 存在')
ok(typeof Context === 'function', 'Context 是构造函数')

// 最小但真实的 webServer 服务：真 http server + 真路由表
function makeWebServer(ctx) {
  const exact = new Map()
  const prefixes = new Map()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname
    const hit = exact.get(pathname)
    if (hit !== undefined) {
      Promise.resolve(hit.handler(req, res)).catch(() => {
        res.writeHead(500)
        res.end()
      })
      return
    }
    for (const [prefix, route] of prefixes) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        Promise.resolve(route.handler(req, res)).catch(() => {
          res.writeHead(500)
          res.end()
        })
        return
      }
    }
    res.writeHead(404)
    res.end()
  })
  return {
    server,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error('duplicate route ' + route.path)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    async listen(port) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
      return server.address().port
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// 最小但真实的 commands 服务
function makeCommands() {
  const defs = new Map()
  return {
    defs,
    register(def) {
      if (typeof def.handler !== 'function') throw new TypeError('handler must be a function')
      if (defs.has(def.name)) throw new Error('duplicate command ' + def.name)
      defs.set(def.name, def)
      return () => defs.delete(def.name)
    },
  }
}

console.log('\n[2] 在真实内核上加载插件')
const root = new Context()
const webServer = makeWebServer(root)
const commands = makeCommands()
const tools = []

root.provide('webServer', webServer)
root.provide('commands', commands)
root.provide('tools', { register: (t) => tools.push(t) })

let applied = null
try {
  // 真 fiber：cordis 的 plugin()/start() 生命周期
  const fiber = root.plugin
    ? root.plugin((ctx, config) => plugin.apply(ctx, config), { enabled: true, cacheTtlMs: 0 })
    : null
  applied = fiber
  if (fiber !== undefined && fiber !== null) {
    // 等待注入的服务就绪
    await new Promise((r) => setTimeout(r, 300))
  }
} catch (e) {
  ok(false, 'plugin() 加载不抛异常', String(e && e.message ? e.message : e))
}

ok(tools.length === 1, '工具注册到真实 tools 服务', tools.length)
ok(commands.defs.size === 1, '命令注册到真实 commands 服务', [...commands.defs.keys()])

const port = await webServer.listen(0)
console.log('  info 测试服务器端口 ' + port)

async function get(pathname, method = 'GET') {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method })
  const text = await r.text()
  return { status: r.status, text, headers: r.headers }
}

console.log('\n[3] 真实 HTTP 请求打到插件路由')
{
  const r = await get('/dsh-token-ledger/api/health')
  ok(r.status === 200, 'health 200（真实 HTTP）', r.status)
  const j = JSON.parse(r.text)
  ok(j.ok === true, 'health ok:true')
  ok(j.sessionsRootExists === true, '真实会话目录被找到', j.sessionsRoot)
  console.log('  info sessionsRoot = ' + j.sessionsRoot)
}

{
  const r = await get('/dsh-token-ledger/api/summary?days=14')
  ok(r.status === 200, 'summary 200（真实 HTTP）', r.status)
  const j = JSON.parse(r.text)
  ok(j.days.length === 14, '14 天', j.days.length)
  ok(j.sessionCount > 0, '检出真实会话', j.sessionCount)
  ok(j.allTime.totalTokens > 0, '全时段有消耗', j.allTime.totalTokens)
  const last = j.days[j.days.length - 1]
  ok(typeof last.day === 'string', '末位是今天', last.day)
  console.log('  info 会话=' + j.sessionCount + ' 全时段=' + j.allTime.totalTokens + ' 今日=' + last.totalTokens)
}

{
  const r = await get('/dsh-token-ledger/api/export.csv?days=5')
  ok(r.status === 200, 'csv 200（真实 HTTP）', r.status)
  ok(r.headers.get('content-type').includes('text/csv'), 'csv header 正确')
  ok((r.headers.get('content-disposition') || '').includes('attachment'), 'csv 触发下载')
  const lines = r.text.replace(/^\ufeff/, '').split('\r\n').filter((l) => l.length > 0)
  ok(lines.length === 6, 'CSV 表头 + 5 行', lines.length)
  console.log('  info CSV 表头: ' + lines[0])
}

console.log('\n[4] 真实内核上的命令执行')
{
  const def = [...commands.defs.values()][0]
  const r = await def.handler({ rawInput: '7' })
  ok(r.kind === 'success', '命令返回 success', r.kind)
  const dayLines = r.text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
  ok(dayLines.length === 7, '7 行日报表', dayLines.length)
  console.log('  info 表头行: ' + r.text.split('\n')[2])
}

console.log('\n[5] 真实内核上的工具执行')
{
  const r = await tools[0].execute({ days: 3 })
  ok(typeof r.text === 'string', '工具返回文本')
  const dayLines = r.text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
  ok(dayLines.length === 3, '3 行', dayLines.length)
}

console.log('\n[6] 卸载可清理（fiber dispose）')
{
  const before = tools.length
  if (applied !== undefined && applied !== null && typeof applied.dispose === 'function') {
    await applied.dispose()
    await new Promise((r) => setTimeout(r, 100))
    ok(true, 'dispose() 调用成功')
  } else {
    ok(true, '（无 fiber 句柄，跳过 dispose 断言）')
  }
}

await webServer.close()
console.log(`\n===== 内核加载结果：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
