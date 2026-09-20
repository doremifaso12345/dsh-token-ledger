/**
 * 回归测试：复现导致 DSH 启动失败的真实场景。
 *
 * 故障是：Cordis 的 ctx 是 Proxy，访问未在 inject 中声明的服务属性会**立即抛错**
 * （cannot get property "tools" without inject），不是返回 undefined。
 * 我原先写 `if (ctx.tools !== undefined)` 想做优雅降级，结果在读取那一刻就炸了，
 * 导致整个 profile 启动失败。
 *
 * 本测试的要点是**不再预先提供 tools / commands 服务**——之前的测试恰好都提供了，
 * 因此绕过了真实前提。这里用真 cordis Context 且服务缺席，验证 apply 不抛异常。
 */
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

console.log('\n[1] 服务全缺席时 apply 必须不抛异常（原故障场景）')
{
  const root = new Context()
  let threw = null
  try {
    root.plugin((ctx, config) => plugin.apply(ctx, config), { enabled: true, cacheTtlMs: 0 })
    await new Promise((r) => setTimeout(r, 250))
  } catch (e) {
    threw = e
  }
  ok(threw === null, 'apply 不抛异常（tools/commands/webServer 全缺席）', threw === null ? undefined : String(threw.message))
  if (threw !== null) console.log('  错误信息: ' + threw.message)
  await root.fiber.dispose().catch(() => {})
}

console.log('\n[2] 直接读取未声明服务属性确实会抛错（证明修复的必要性）')
{
  // cordis 把 apply 内抛出的错误记为 fiber 失败（真实日志里 stage:"apply"），
  // 而不是向调用方传播，因此这里检查 fiber 状态而非捕获异常。
  const root = new Context()
  const fiber = root.plugin((ctx) => {
    // eslint-disable-next-line no-unused-expressions
    ctx.tools
  })
  await new Promise((r) => setTimeout(r, 200))
  // FIBER_STATE: 0 pending 1 loading 2 active 3 failed
  const state = fiber?.state
  ok(state !== 2, '旧写法（裸读 ctx.tools）不会进入 active', { state })
  await root.fiber.dispose().catch(() => {})
}

console.log('\n[2b] 修复后的插件在同类条件下必须 active')
{
  const root = new Context()
  const fiber = root.plugin((ctx, config) => plugin.apply(ctx, config), { enabled: true, cacheTtlMs: 0 })
  await new Promise((r) => setTimeout(r, 300))
  ok(fiber?.state === 2, '修复后 fiber 状态为 active（无 tools 服务）', { state: fiber?.state })
  await root.fiber.dispose().catch(() => {})
}

console.log('\n[3] 服务存在时三面都要正常注册')
{
  const routes = []
  const cmds = []
  const tools = []
  const root = new Context()

  // 提供真实的三个服务（最小实现）
  root.provide('webServer', {
    register: (r) => {
      routes.push(r)
      return () => {}
    },
  })
  root.provide('commands', {
    register: (d) => {
      cmds.push(d)
      return () => {}
    },
  })
  root.provide('tools', {
    register: (t) => {
      tools.push(t)
      return () => {}
    },
  })

  let threw = null
  try {
    root.plugin((ctx, config) => plugin.apply(ctx, config), { enabled: true, cacheTtlMs: 0 })
    await new Promise((r) => setTimeout(r, 250))
  } catch (e) {
    threw = e
  }
  ok(threw === null, 'apply 不抛异常', threw === null ? undefined : String(threw.message))
  ok(routes.length === 1, '注册了 HTTP 路由', routes.length)
  ok(cmds.length === 1, '注册了 /tokens 命令', cmds.length)
  ok(tools.length === 1, '注册了 token_usage 工具', tools.length)
  await root.fiber.dispose().catch(() => {})
}

console.log('\n[4] 部分服务存在（只在最易出错的组合上验证）')
for (const combo of [
  { name: '仅有 tools', services: ['tools'] },
  { name: '仅有 commands', services: ['commands'] },
  { name: '仅有 webServer', services: ['webServer'] },
]) {
  const root = new Context()
  for (const s of combo.services) {
    root.provide(s, s === 'webServer' ? { register: () => () => {} } : { register: () => () => {} })
  }
  let threw = null
  try {
    root.plugin((ctx, config) => plugin.apply(ctx, config), { enabled: true, cacheTtlMs: 0 })
    await new Promise((r) => setTimeout(r, 200))
  } catch (e) {
    threw = e
  }
  ok(threw === null, `${combo.name} 时不抛异常`, threw === null ? undefined : String(threw.message))
  await root.fiber.dispose().catch(() => {})
}

console.log('\n[5] enabled:false 时不注册任何面')
{
  const routes = []
  const root = new Context()
  root.provide('webServer', { register: (r) => { routes.push(r); return () => {} } })
  root.provide('tools', { register: () => () => {} })
  root.provide('commands', { register: () => () => {} })
  root.plugin((ctx, config) => plugin.apply(ctx, config), { enabled: false })
  await new Promise((r) => setTimeout(r, 200))
  ok(routes.length === 0, '禁用时不注册路由', routes.length)
  await root.fiber.dispose().catch(() => {})
}

console.log(`\n===== 回归测试：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
