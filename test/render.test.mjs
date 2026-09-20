/**
 * 仪表盘真实挂载测试。
 *
 * 为什么需要它：`react-dom/server` 的静态渲染**不执行 useEffect**，
 * 所以数据到手后的界面（指标条、热力图、工具排行、会话明细）根本没被渲染过——
 * 之前的测试只证明"空态不抛错"，那是个盲区。
 *
 * 这里用 jsdom 造真实 DOM，用 react-dom/client 真正挂载，让 effect 与
 * fetch 承诺链跑完，然后断言产出内容。这是能在 Node 里自动验证异步渲染的唯一方式。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/plugins/dsh-token-ledger'
const APP_MODULES = 'D:/dsh/DeepSeek Harness Desktop/DSH Desktop/resources/app/node_modules'
const PROFILE_MODULES = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/profiles/node_modules'

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

// ── 1) 取真实 API 数据（直接跑宿主插件的路由处理器）────────────────
const hostMod = await import(pathToFileURL(PLUGIN + '/lib/index.js').href)
const routes = []
const hctx = {
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
  inject: (deps, fn) => {
    const list = Array.isArray(deps) ? deps : Object.keys(deps)
    if (!list.every((n) => ['webServer', 'commands', 'tools'].includes(n))) return
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
let realBody = ''
// 用客户端**真实的请求 URL**（不带 weeks，走服务端默认），
// 这样预览与实际用户所见一致；写死周数会让预览与真实界面脱节。
await routes[0].handler(
  { method: 'GET', url: '/dsh-token-ledger/api/summary?days=30' },
  { writeHead: () => {}, end: (b) => { realBody = String(b) } }
)
const realData = JSON.parse(realBody)

console.log('\n[1] 真实数据前置条件')
ok(realData.metrics !== undefined, 'API 含 metrics')
const HM_WEEKS = realData.heatmap.weeks
ok(HM_WEEKS === 52, `热力图默认 52 周（年度视图）`, HM_WEEKS)
ok(realData.heatmap.cells.length === HM_WEEKS * 7, `热力图 ${HM_WEEKS} 周 = ${HM_WEEKS * 7} 格`, realData.heatmap.cells.length)
ok(realData.tools.length > 0, '含工具统计', realData.tools.length)

// ── 2) jsdom 环境 ────────────────────────────────────────────────
// react-dom 在模块初始化与提交阶段都直接读**全局** window/document，
// 因此必须在 require react-dom 之前把它们挂到 globalThis 上。
const { JSDOM } = await import(pathToFileURL(PROFILE_MODULES + '/jsdom/lib/api.js').href)
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
const win = dom.window

globalThis.window = win
globalThis.document = win.document
// Node 24 自带只读的 navigator，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true })
for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'MessageChannel', 'MutationObserver']) {
  if (win[key] !== undefined) globalThis[key] = win[key]
}
globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win)
globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win)

// react / react-dom/client 从 app 模块解析（profile 下没有 react-dom）
const req = createRequire(APP_MODULES + '/x.js')
const React = req('react')
const ReactDOMClient = req('react-dom/client')

console.log('\n[2] 环境就绪')
ok(typeof React.createElement === 'function', 'react 可用', React.version)
ok(typeof ReactDOMClient.createRoot === 'function', 'react-dom/client 可用')

// ── 3) 加载插件客户端 bundle ─────────────────────────────────────
const src = fs.readFileSync(PLUGIN + '/client.js', 'utf8')
const fakeDocument = win.document
let registration = null
const fakeWindow = {
  __ModuleLoader__: { load: (r) => { registration = r } },
  location: { origin: 'http://127.0.0.1:3080' },
  open: () => {},
  fetch: null,
  setInterval: win.setInterval.bind(win),
  clearInterval: win.clearInterval.bind(win),
}
const fn = new Function(
  'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'URL', 'Intl',
  'AbortController', 'setTimeout', 'clearTimeout', 'console',
  src
)
// fetch 走 mock，返回真实数据
const mockFetch = async () => ({
  ok: true, status: 200, statusText: 'OK',
  text: async () => realBody,
})
fn(fakeWindow, fakeDocument, mockFetch, win.setInterval.bind(win), win.clearInterval.bind(win),
   URL, Intl, class { constructor() { this.signal = null } abort() {} },
   win.setTimeout.bind(win), win.clearTimeout.bind(win), console)

ok(registration !== null, 'bundle 已注册', registration && registration.id)

const exportsObj = registration.factory((n) => {
  if (n === 'react') return React
  throw new Error('unexpected require: ' + n)
})

// ── 4) 挂载并等待异步数据 ────────────────────────────────────────
const registered = []
// 捕获插件真实注册的字典，否则 t() 只会返回键名，中文断言就失去意义
const dictionaries = []
const ctx = {
  effect: (f) => { try { const d = f(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
  slots: {
    inject: (name, f) => f(),
    register: (opts, comp) => { registered.push({ opts, comp }); return () => {} },
  },
  locale: {
    register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} },
    bind: (ns) => {
      const hit = dictionaries.find((d) => d.ns === ns)
      const table = hit === undefined ? {} : hit.dict.zh ?? hit.dict.en ?? {}
      return (key, params) => {
        let s = table[key] ?? key
        if (params !== undefined && typeof s === 'string') {
          for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
        return s
      }
    },
  },
}

let applyErr = null
try {
  exportsObj.apply(ctx)
} catch (e) {
  applyErr = e
}
ok(applyErr === null, 'apply 不抛错', applyErr && applyErr.message)

const section = registered.find((r) => r.opts.name === 'settings.section')
ok(section !== undefined, '找到设置卡片组件')

const root = ReactDOMClient.createRoot(win.document.getElementById('root'))
let renderErr = null
// React 的错误会通过 onUncaughtError 上报；这里同时捕获同步异常
try {
  root.render(React.createElement(section.comp, {}))
} catch (e) {
  renderErr = e
}
ok(renderErr === null, 'render 调用不抛错', renderErr && renderErr.message)

// 等待 effect + fetch 承诺链 + 一次重渲染
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
await tick(120)
await tick(250)

const html = win.document.getElementById('root').innerHTML

console.log('\n[3] 数据到手后的渲染内容')
console.log(`  HTML 长度: ${html.length} 字节`)
ok(html.length > 2000, `渲染内容非空且充实（${html.length} 字节）`, html.length)

// 指标条
ok(html.includes('dshTlStats'), '有指标条容器')
ok(html.includes('dshTlStatV'), '有指标数值')
const statValues = [...html.matchAll(/dshTlStatV">([^<]+)</g)].map((m) => m[1])
ok(statValues.length === 5, `指标条 5 项`, statValues)
console.log('  指标:', statValues.join(' | '))
// 累计 token 应渲染成紧凑记法
ok(statValues.some((v) => /[KMB]$/.test(v)), '累计值用了紧凑记法', statValues[0])
// 最长聊天时长应是人类可读
ok(statValues.some((v) => /小时|分|秒/.test(v)), '最长时长是人类可读格式', statValues[2])
// 连续天数
ok(statValues.some((v) => /天/.test(v)), '连续天数带「天」', statValues.slice(3))

// 热力图
const cellCount = (html.match(/class="dshTlCell/g) || []).length
ok(cellCount === HM_WEEKS * 7, `热力图渲染 ${HM_WEEKS * 7} 格`, cellCount)
const lv = { 1: 0, 2: 0, 3: 0, 4: 0 }
// 只统计**网格格子**：图例色块（dshTlLegendBox）也带 dshTlL* 类，
// 不排除它们会把图例算成数据，得到虚高的有色格数。
for (const m of html.matchAll(/class="dshTlCell[^"]*dshTlL([1-4])"/g)) lv[m[1]] += 1
console.log('  热力分级:', JSON.stringify(lv))
const expectedNonZero = realData.heatmap.cells.filter((c) => c.totalTokens > 0).length
const renderedNonZero = lv[1] + lv[2] + lv[3] + lv[4]
ok(renderedNonZero === expectedNonZero, `有色格数 = 有数据天数（${expectedNonZero}）`, renderedNonZero)
// 图例应有 5 级色块（含空色），且每一级各自带 dshTlL0..4，
// 不能依赖内联样式——曾经图例方块全部无色的原因是 CSS 源码顺序覆盖。
const legendBoxes = (html.match(/class="dshTlLegendBox/g) || []).length
ok(legendBoxes === 5, '图例 5 级（含空格）', legendBoxes)
ok(html.includes('dshTlLegend'), '有热力图图例')
for (const lv of [0, 1, 2, 3, 4]) {
  ok(
    new RegExp(`class="dshTlLegendBox dshTlL${lv}"`).test(html),
    `图例第 ${lv} 级带 dshTlL${lv} 类`
  )
}

// 月份刻度（参考图里网格下方有月份标签）
ok(html.includes('dshTlHeatMonths'), '有月份刻度容器')
const monthCells = (html.match(/class="dshTlHeatMonth"/g) || []).length
ok(monthCells >= 10, `月份刻度数量合理（${monthCells} 个，52 周跨约 12 个月）`, monthCells)
ok(/dshTlHeatMonth"[^>]*>(\d+)月</.test(html), '月份标签格式为「N月」')
// 标签必须是完整的「N月」两个字：曾被 overflow:hidden 裁成半个字
const monthLabelTexts = [...html.matchAll(/dshTlHeatMonth"[^>]*>([^<]*)</g)].map((m) => m[1])
ok(
  monthLabelTexts.every((s) => /^\d{1,2}月$/.test(s)),
  '月份标签文字完整（未被裁剪）',
  monthLabelTexts.slice(0, 6)
)

// 工具排行
ok(html.includes('dshTlToolName'), '有工具排行')
const toolNames = [...html.matchAll(/dshTlToolName">([^<]+)</g)].map((m) => m[1])
ok(toolNames.length > 0, `工具条目 ${toolNames.length} 个`, toolNames.slice(0, 4))
ok(toolNames[0] === realData.tools[0].name, '首个工具与数据一致', [toolNames[0], realData.tools[0].name])

// 日表与会话明细（默认折叠，确认容器在）
ok(html.includes('dshTlTableWrap'), '有表格容器')

// 无 React 报错痕迹
ok(!/ERROR|错误|undefined/.test(html), '页面无错误文案残留')

// 样式是否注入到 head
const styleEl = win.document.getElementById('dsh-token-ledger-style-v3')
ok(styleEl !== null, '样式已注入 head（v3）')
if (styleEl !== null) {
  ok(styleEl.textContent.includes('--dsw-alias-'), '样式使用宿主主题变量')
  ok(styleEl.textContent.includes('dshTlHeatGrid'), '样式含热力图规则')
}

// 输出 HTML 供人工/截图复核。
// 关键：必须**同时**带上宿主主题变量与插件自己注入的样式表，
// 否则导出的页面是无样式文档流（热力格子会塌成 0 尺寸、指标条不会成行），
// 那样截图不能反映真实观感。
// 写到系统临时目录，避免污染用户工作区。
const dumpPath = path.join(os.tmpdir(), 'dsh-token-ledger-rendered.html')
const themeCss = (() => {
  const themeSrc = fs.readFileSync(APP_MODULES + '/@deepseek-ai/dsh-client-ui-theme/lib/client.js', 'utf8')
  const m = themeSrc.match(/var design_platform_css_default = "((?:[^"\\]|\\.)*)"/)
  return m === null ? '' : JSON.parse('"' + m[1] + '"')
})()
const pluginCss = styleEl === null ? '' : styleEl.textContent
ok(pluginCss.length > 0, '导出时带上了插件样式表', pluginCss.length)

console.log('\n[4] 样式结构回归（两个真实踩过的坑）')
{
  // 坑一：等级色被覆盖。
  // .dshTlCell / .dshTlLegendBox 与 .dshTlL1..4 同为单类选择器，靠源码顺序决胜，
  // 因此等级色必须排在容器规则之后，且容器不得自带 background。
  const idxCell = pluginCss.indexOf('.dshTlCell{')
  const idxL1 = pluginCss.indexOf('.dshTlL1{')
  const idxLegendBox = pluginCss.indexOf('.dshTlLegendBox{')
  ok(idxCell !== -1 && idxL1 !== -1, '能定位 .dshTlCell 与 .dshTlL1')
  ok(idxL1 > idxCell, '等级色定义在 .dshTlCell 之后（否则被空色覆盖）', { idxCell, idxL1 })
  ok(idxLegendBox !== -1, '能定位 .dshTlLegendBox')
  const legendRule = pluginCss.match(/\.dshTlLegendBox\{([^}]*)\}/)
  ok(legendRule !== null, '存在 .dshTlLegendBox 规则')
  if (legendRule !== null) {
    ok(!/background/.test(legendRule[1]), '.dshTlLegendBox 不设 background（避免覆盖等级色）', legendRule[1])
  }
  ok(/\.dshTlL0\{background/.test(pluginCss), '存在 .dshTlL0 空色级（图例空格用）')

  // 坑二：月份标签被裁。
  // 标签落在 11px 宽的网格列里，文字约 20px，overflow:hidden 会把「3月」裁成半个字。
  const monthRule = pluginCss.match(/\.dshTlHeatMonth\{([^}]*)\}/)
  ok(monthRule !== null, '存在 .dshTlHeatMonth 规则')
  if (monthRule !== null) {
    ok(!/overflow\s*:\s*hidden/.test(monthRule[1]), '.dshTlHeatMonth 不得 overflow:hidden（否则裁字）', monthRule[1])
  }
}

fs.writeFileSync(
  dumpPath,
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${themeCss}</style><style>${pluginCss}</style><style>body{margin:0;background:var(--dsw-alias-bg-base,#fff)}#wrap{padding:20px 24px;max-width:1040px}</style></head><body><div id="wrap">${html}</div></body></html>`,
  'utf8'
)
console.log(`\n  已导出渲染结果: ${dumpPath}`)

// 清理，避免 setInterval 让进程挂住
await root.unmount()
dom.window.close()

console.log(`\n===== 渲染测试：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
