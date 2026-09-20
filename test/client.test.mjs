/**
 * 客户端半的真实渲染测试。
 *
 * 抓取 client.js（多插件共享的 CommonJS 工厂），用真实 react + react-dom/server
 * 实际渲染两个组件。目的：捕获只有在真渲染时才会暴露的错误
 * （hooks 误用、undefined 解构、样式对象写错等），而不只是"语法通过"。
 *
 * 同时验证：
 * - 工厂只 require 图内模块，且导出 name/inject/apply
 * - inject 声明的服务名都是客户端真实存在的（否则 client fiber 会 pending，
 *   进而让 web boot 的 assertEntriesActive 抛错、整个界面起不来）
 */
import fs from 'node:fs'
import path from 'node:path'

const PROFILE_MODULES = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/profiles/node_modules'
const CLIENT = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/plugins/dsh-token-ledger/client.js'

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

// 用真实 react + react-dom（与运行时同为 18.3.1），从 harness 应用自身解析。
import { createRequire } from 'node:module'
const APP_MODULES = 'D:/dsh/DeepSeek Harness Desktop/DSH Desktop/resources/app/node_modules'
const req = createRequire(APP_MODULES + '/x.js')
const React = req('react')
const ReactDOMServer = req('react-dom/server')
console.log('  info react 版本: ' + (React.version ?? 'unknown'))

console.log('\n[1] 加载客户端 bundle（模拟 window.__ModuleLoader__）')
const source = fs.readFileSync(CLIENT, 'utf8')
let registration = null
const fakeWindow = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
  location: { origin: 'http://127.0.0.1:3080' },
  open: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}
// 让 bundle 顶层 IIFE 能拿到 window / document
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
}

const fn = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'URL', 'Intl', 'AbortController', 'setTimeout', 'clearTimeout', 'console', source)

let loadErr = null
try {
  fn(fakeWindow, fakeDocument, async () => { throw new Error('no fetch in test') }, () => 0, () => {}, URL, Intl, class { constructor() { this.signal = null } abort() {} }, setTimeout, clearTimeout, console)
} catch (e) {
  loadErr = e
}
ok(loadErr === null, 'bundle 顶层执行不抛错', loadErr === null ? undefined : String(loadErr.message))
ok(registration !== null, '调用了 __ModuleLoader__.load', registration === null ? undefined : registration.id)
if (registration === null) {
  console.log(`\n===== 客户端测试：PASS ${pass} / FAIL ${fail} =====`)
  process.exit(1)
}

console.log('\n[2] 工厂导出契约')
const requireMap = { react: React }
let exportsObj = null
try {
  exportsObj = registration.factory((name) => {
    if (name in requireMap) return requireMap[name]
    throw new Error('unexpected require: ' + name)
  })
} catch (e) {
  ok(false, '工厂执行不抛错', String(e.message))
}
ok(exportsObj !== null, '工厂返回 exports')
ok(typeof exportsObj?.apply === 'function', '导出 apply')
ok(Array.isArray(exportsObj?.inject), '导出 inject', exportsObj?.inject)
ok(exportsObj?.name === 'dsh-token-ledger', '导出 name', exportsObj?.name)

console.log('\n[3] inject 声明的服务必须在客户端真实存在')
{
  // 客户端服务名 -> 提供者包
  const PROVIDERS = {
    slots: '@deepseek-ai/dsh-client-ui-slots',
    locale: '@deepseek-ai/dsh-client-locale',
  }
  for (const s of exportsObj?.inject ?? []) {
    const pkg = PROVIDERS[s]
    ok(pkg !== undefined, `服务 "${s}" 有已知提供者`, { service: s })
    if (pkg !== undefined) {
      ok(fs.existsSync(path.join(PROFILE_MODULES, pkg)), `提供者包存在: ${pkg}`)
    }
  }
}

console.log('\n[4] 真实渲染两个组件（捕获运行期错误）')
{
  // 收集注册到 slot 的组件
  const registered = []
  const slotsService = {
    inject: (slotName, fn) => {
      // 真实语义：slot 声明就绪后回调；这里立即回调
      fn()
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  }
  const dictionaries = []
  const localeService = {
    register: (ns, dict) => {
      dictionaries.push({ ns, dict })
      return () => {}
    },
    bind: (ns) => {
      const found = dictionaries.find((d) => d.ns === ns)
      const dict = found ? found.dict.zh ?? found.dict.en ?? {} : {}
      return (key) => dict[key] ?? key
    },
  }
  const effects = []
  const ctx = {
    effect: (fn2, label) => {
      const d = fn2()
      effects.push(label)
      return typeof d === 'function' ? d : () => {}
    },
    slots: slotsService,
    locale: localeService,
  }

  let applyErr = null
  try {
    exportsObj.apply(ctx)
  } catch (e) {
    applyErr = e
  }
  ok(applyErr === null, 'apply 不抛错', applyErr === null ? undefined : String(applyErr.message))
  ok(registered.length === 2, '注册了 2 个 slot 组件（设置卡片 + 徽标）', registered.length)
  ok(dictionaries.length === 1, '注册了 1 份字典', dictionaries.length)
  ok(effects.length >= 1, '至少注册了 1 个 effect', effects)

  const slotNames = registered.map((r) => r.options.name).sort()
  ok(slotNames.includes('settings.section'), '注册到 settings.section', slotNames)
  ok(slotNames.includes('conversation.input.dock'), '注册到 conversation.input.dock', slotNames)
  ok(registered.every((r) => typeof r.options.id === 'string' && r.options.id.length > 0), '每个注册都有 id')
  ok(registered.every((r) => r.options.name !== 'settings.section' || typeof r.options.label === 'function'), 'settings.section 注册带 label')

  // 真渲染：初始状态（data=null，加载中）
  for (const r of registered) {
    let out = null
    let renderErr = null
    try {
      out = ReactDOMServer.renderToStaticMarkup(React.createElement(r.component, {}))
    } catch (e) {
      renderErr = e
    }
    ok(renderErr === null, `渲染 ${r.options.name} 不抛错`, renderErr === null ? undefined : String(renderErr.message))
    if (out !== null) {
      ok(typeof out === 'string' && out.length > 0, `${r.options.name} 产出非空 HTML（${out.length} 字节）`)
    }
  }
}

console.log('\n[5] 在带数据的场景下再渲染一次（覆盖表格/指标分支）')
{
  // 直接用真实 API 数据渲染两个组件，并让 fetch 返回它，
  // 覆盖表格、热力图、工具排行、会话明细等分支。
  const { pathToFileURL } = await import('node:url')
  const hostMod = await import(
    pathToFileURL('C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/plugins/dsh-token-ledger/lib/index.js').href
  )
  const routes = []
  const hctx = {
    effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
    inject: (deps, fn) => {
      const list = Array.isArray(deps) ? deps : Object.keys(deps)
      const avail = ['webServer', 'commands', 'tools']
      if (!list.every((n) => avail.includes(n))) return
      const sub = { effect: hctx.effect }
      for (const n of list) {
        if (n === 'webServer') sub.webServer = { register: (r) => { routes.push(r); return () => {} } }
        if (n === 'commands') sub.commands = { register: () => () => {} }
        if (n === 'tools') sub.tools = { register: () => () => {} }
      }
      fn(sub)
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  hostMod.apply(hctx, { enabled: true, cacheTtlMs: 0 })
  let body = ''
  await routes[0].handler({ method: 'GET', url: '/dsh-token-ledger/api/summary?days=30&weeks=26' }, {
    writeHead: () => {}, end: (b) => { body = String(b) },
  })
  const realData = JSON.parse(body)
  ok(realData.metrics !== undefined, '真实 API 含 metrics')
  ok(realData.heatmap !== undefined && realData.heatmap.cells.length > 0, '真实 API 含热力图')
  ok(Array.isArray(realData.tools) && realData.tools.length > 0, '真实 API 含工具统计')

  // 用真实数据渲染
  const registered2 = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => body })
  try {
    const ctx2 = {
      effect: (f) => { f(); return () => {} },
      slots: { inject: (n, fn) => fn(), register: (o, c) => { registered2.push({ o, c }); return () => {} } },
      locale: { register: () => () => {}, bind: () => (k) => k },
    }
    exportsObj.apply(ctx2)
    for (const r of registered2) {
      let out = null
      let e2 = null
      try {
        out = ReactDOMServer.renderToStaticMarkup(React.createElement(r.c, {}))
      } catch (err) {
        e2 = err
      }
      ok(e2 === null, `带数据渲染 ${r.o.name} 不抛错`, e2 === null ? undefined : String(e2.message))
      if (out !== null) {
        ok(out.length > 0, `${r.o.name} 带数据产出 HTML（${out.length} 字节）`)
      }
    }
    // 设置卡片应含热力图与指标条关键类名
    const section = registered2.find((r) => r.o.name === 'settings.section')
    if (section !== undefined) {
      const html = ReactDOMServer.renderToStaticMarkup(React.createElement(section.c, {}))
      ok(/dshTlStats|dshTlCard/.test(html), '设置卡片包含仪表盘结构')
    }
  } finally {
    globalThis.fetch = origFetch
  }
}

console.log('\n[6] 主题安全：不得出现硬编码颜色、必须使用宿主语义变量')
{
  const src = fs.readFileSync(CLIENT, 'utf8')
  // 提取 CSS 常量块
  const cssMatch = src.match(/const CSS = `([\s\S]*?)`\n/)
  ok(cssMatch !== null, '能定位 CSS 块')
  const css = cssMatch === null ? '' : cssMatch[1]

  // 每一处颜色都必须是 var(--dsw-...)（可带兜底值），不能是裸色值。
  // 硬编码深色曾在浅色主题下渲染成一条黑杠。
  const bareColors = []
  for (const line of css.split('\n')) {
    // 跳过注释行
    if (line.trim().startsWith('/*') || line.trim().startsWith('*')) continue
    // 找出没有被 var(...) 包裹的颜色字面量
    const stripped = line.replace(/var\([^)]*\)/g, '')
    const hits = stripped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)
    if (hits !== null) bareColors.push({ line: line.trim(), hits })
  }
  ok(bareColors.length === 0, 'CSS 中无裸色值（全部走宿主变量）', bareColors.slice(0, 5))

  // 必须确实引用了宿主主题变量。
  // 注意：变量名定义在 V 对象里、经模板插值进入 CSS，所以要在整个源文件里找引用。
  const hostVars = new Set((src.match(/--dsw-alias-[a-z0-9-]+/g) ?? []))
  ok(hostVars.size >= 6, `引用了 ${hostVars.size} 个宿主语义变量`, [...hostVars].slice(0, 10))
  ok([...hostVars].some((v) => v.includes('label-')), '引用了标签（文字）变量')
  ok([...hostVars].some((v) => v.includes('bg-layer-')), '引用了背景层变量')
  ok([...hostVars].some((v) => v.includes('border-')), '引用了边框变量')
  // CSS 里引用的每个 V.* 键都必须有定义，否则插值成 undefined 会产出非法样式
  const usedKeys = new Set((css.match(/\$\{V\.([a-zA-Z0-9]+)\}/g) ?? []).map((s) => s.slice(4, -1)))
  ok(usedKeys.size > 0, `CSS 使用了 ${usedKeys.size} 个变量键`, [...usedKeys])
  const vBlock = src.match(/const V = \{([\s\S]*?)\n\s*\}/)
  ok(vBlock !== null, '能定位 V 定义块')
  if (vBlock !== null) {
    const defined = new Set((vBlock[1].match(/^\s*([a-zA-Z0-9]+):/gm) ?? []).map((s) => s.trim().replace(':', '')))
    const missing = [...usedKeys].filter((k) => !defined.has(k))
    ok(missing.length === 0, 'CSS 用到的变量键全部有定义', missing)
    // 每个定义都必须是 var(--dsw-..., 兜底) 形式
    const defs = vBlock[1].split('\n').filter((l) => l.includes('var(--dsw-'))
    ok(defs.length === defined.size, `全部 ${defined.size} 个变量都基于 var(--dsw-...)`, { defs: defs.length, defined: defined.size })
  }

  // 徽标必须显式阻止 flex 拉伸（否则在 dock 里会变成整行色带）
  const badgeRule = css.match(/\.dshTlBadgeWrap\{([^}]*)\}/)
  ok(badgeRule !== null, '存在 .dshTlBadgeWrap 规则')
  if (badgeRule !== null) {
    const rule = badgeRule[1]
    ok(/display:\s*inline-flex/.test(rule), 'Wrapper 用 inline-flex')
    ok(/flex:\s*0\s+0\s+auto/.test(rule), 'Wrapper 设 flex:0 0 auto（防拉伸）')
    ok(/width:\s*fit-content/.test(rule), 'Wrapper 宽度收成内容宽')
  }

  // 不得残留旧变量命名（作用域断裂的根源）
  ok(!/--tl-/.test(css), '无残留的 --tl-* 自定义变量（早期版本作用域断裂）')

  // 样式 id 必须带版本，避免旧样式残留
  ok(/dsh-token-ledger-style-v\d+/.test(src), '样式 id 带版本号')
}

console.log(`\n===== 客户端测试：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
