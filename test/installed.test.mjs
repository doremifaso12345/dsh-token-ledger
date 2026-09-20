/**
 * 对**实际被加载的安装副本**做端到端验证。
 * 前面所有测试都跑在源目录，这里显式验证 profile 里的那一份。
 *
 * 替身 ctx 必须模拟 Cordis 的真实语义：插件用 `ctx.inject(['x'], cb)` 声明依赖，
 * 服务可用时 cb 执行。早期替身直接提供 `ctx.tools` 属性，掩盖了
 * "裸读未声明服务会抛错"这一真实前提，导致启动故障没被测试捕获。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const P = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules/dsh-token-ledger'
const mod = await import(pathToFileURL(P + '/lib/index.js').href)

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

const routes = []
const cmds = []
const tools = []
const ctx = {
  effect: (f) => {
    const d = f()
    return typeof d === 'function' ? d : () => {}
  },
  inject: (deps, fn) => {
    const list = Array.isArray(deps) ? deps : Object.keys(deps)
    const available = ['webServer', 'commands', 'tools']
    if (!list.every((n) => available.includes(n))) return
    const sub = { effect: ctx.effect }
    for (const name of list) {
      if (name === 'webServer') sub.webServer = { register: (r) => { routes.push(r); return () => {} } }
      if (name === 'commands') sub.commands = { register: (d) => { cmds.push(d); return () => {} } }
      if (name === 'tools') sub.tools = { register: (t) => { tools.push(t); return () => {} } }
    }
    fn(sub)
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

mod.apply(ctx, { enabled: true, cacheTtlMs: 0 })

let status = 0
let payload = ''
const res = { writeHead: (s) => { status = s }, end: (b) => { payload = String(b) } }
await routes[0].handler({ method: 'GET', url: '/dsh-token-ledger/api/summary?days=7' }, res)

const j = JSON.parse(payload)
const today = j.days.find((d) => d.day === j.today)

console.log('\n[1] 三面注册')
ok(routes.length === 1, 'routes=1', routes.length)
ok(cmds.length === 1, 'commands=1', cmds.length)
ok(tools.length === 1, 'tools=1', tools.length)

console.log('\n[2] 路由与数据')
ok(status === 200 && j.ok === true, 'summary 200 且 ok', { status, ok: j.ok })
ok(j.days.length === 7, '返回 7 天', j.days.length)

console.log('\n[3] 命令与工具')
const cmdRes = await cmds[0].handler({ rawInput: '7' })
ok(cmdRes.kind === 'success', '命令返回 success', cmdRes.kind)
const toolRes = await tools[0].execute({ days: 3 })
ok(typeof toolRes.text === 'string' && toolRes.text.length > 0, '工具返回文本')

console.log('')
console.log('安装副本加载      : ok=' + j.ok + '  status=' + status)
console.log('会话数 / 文件数   : ' + j.sessionCount + ' / ' + j.fileCount)
console.log('全时段合计        : ' + j.allTime.totalTokens.toLocaleString('en-US') + ' token')
console.log('今日(' + j.today + ')     : ' + (today ? today.totalTokens.toLocaleString('en-US') : 0) + ' token')
console.log('最近 7 天合计     : ' + j.recentTotals.totalTokens.toLocaleString('en-US') + ' token')
console.log('缓存命中率(全时段): ' + (j.allTime.cacheHitRate * 100).toFixed(1) + '%')
console.log('命令输出首行      : ' + cmdRes.text.split('\n')[0])
console.log('工具输出行数      : ' + toolRes.text.split('\n').length)

console.log(`\n===== 安装副本验证：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
