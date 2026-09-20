/**
 * 环境契约测试。
 *
 * 锁住两件容易写错、且错了很难发现的事：
 * 1. `package.json` 的 engines 必须与代码里的要求一致——两处漂移过一次
 *    （原先写 `>=18`，但 zstd 解压在 Node 18 根本不存在）。
 * 2. 这个范围必须真的排除 23.0–23.7：zstd 在 23.8.0 上游加入、回移到 22.15.0，
 *    中间那一段没有。写成 `>=22` 会把一段不可用的版本放进来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/plugins/dsh-token-ledger'
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

const zf = await import(pathToFileURL(PLUGIN + '/lib/zstd-frames.js').href)
const pkg = JSON.parse(fs.readFileSync(PLUGIN + '/package.json', 'utf8'))
const req = createRequire(PROFILE_MODULES + '/x.js')
const semver = req('semver')

console.log('\n[1] 代码常量与 package.json 一致')
ok(typeof zf.NODE_REQUIREMENT === 'string' && zf.NODE_REQUIREMENT.length > 0, '导出 NODE_REQUIREMENT', zf.NODE_REQUIREMENT)
ok(
  pkg.engines?.node === zf.NODE_REQUIREMENT,
  `package.json engines.node 与代码一致`,
  { engines: pkg.engines?.node, code: zf.NODE_REQUIREMENT }
)
ok(semver.validRange(zf.NODE_REQUIREMENT) !== null, '是合法的 semver 范围', zf.NODE_REQUIREMENT)

console.log('\n[2] 范围语义：必须排除没有 zstd 的 23.0–23.7')
const cases = [
  ['22.14.0', false, 'zstd 回移前的 22.x：无该 API'],
  ['22.15.0', true, 'zstd 回移版本：有'],
  ['22.20.0', true, '22 LTS 后续：有'],
  ['23.0.0', false, '23 系开头：没有'],
  ['23.7.9', false, '23.8.0 之前：没有'],
  ['23.8.0', true, '上游加入版本：有'],
  ['24.9.0', true, '当前桌面端所在版本：有'],
  ['18.20.0', false, '旧版：没有'],
]
for (const [v, want, why] of cases) {
  ok(semver.satisfies(v, zf.NODE_REQUIREMENT) === want, `Node ${v} → ${want ? '满足' : '不满足'}（${why}）`)
}

console.log('\n[3] 当前环境确实可用（否则后面的数据测试都无意义）')
ok(zf.ZSTD_AVAILABLE === true, `当前 ${process.version} 提供 zlib.zstdDecompressSync`)
ok(semver.satisfies(process.version.replace(/^v/, ''), zf.NODE_REQUIREMENT) === true, '当前版本落在声明范围内', process.version)

console.log('\n[4] 缺失时不得静默返回空数据')
{
  // 无法真的卸掉 zstd，但可以断言守卫存在：readZstdLines 在不可用时应抛错。
  // 通过临时替换 zlib 的导出不可行（ESM 只读），改为检查源码含该守卫。
  const src = fs.readFileSync(PLUGIN + '/lib/zstd-frames.js', 'utf8')
  ok(/if \(!ZSTD_AVAILABLE\)/.test(src) && /Refusing to silently report zero usage/.test(src), 'readZstdLines 有显式守卫且拒绝静默返回 0')
  const ledgerSrc = fs.readFileSync(PLUGIN + '/lib/ledger.js', 'utf8')
  ok(/if \(!ZSTD_AVAILABLE\)/.test(ledgerSrc) && /UNSUPPORTED_NODE/.test(ledgerSrc), 'scan() 在缺失时返回 fatal 而非空结果')
}

console.log('\n[5] /api/health 暴露环境自检字段')
{
  const host = await import(pathToFileURL(PLUGIN + '/lib/index.js').href)
  const routes = []
  const ctx = {
    effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
    inject: (deps, fn) => {
      const list = Array.isArray(deps) ? deps : Object.keys(deps)
      if (!list.every((n) => ['webServer', 'commands', 'tools'].includes(n))) return
      const sub = { effect: ctx.effect }
      for (const n of list) {
        if (n === 'webServer') sub.webServer = { register: (r) => { routes.push(r); return () => {} } }
        if (n === 'commands') sub.commands = { register: () => () => {} }
        if (n === 'tools') sub.tools = { register: () => () => {} }
      }
      fn(sub)
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  host.apply(ctx, { enabled: true, cacheTtlMs: 0 })
  let body = ''
  await routes[0].handler({ method: 'GET', url: '/dsh-token-ledger/api/health' }, {
    writeHead: () => {}, end: (b) => { body = String(b) },
  })
  const j = JSON.parse(body)
  ok(j.zstdAvailable === true, 'health.zstdAvailable = true')
  ok(j.nodeVersion === process.version, 'health.nodeVersion 正确', j.nodeVersion)
  ok(j.nodeRequirement === zf.NODE_REQUIREMENT, 'health.nodeRequirement 与代码一致', j.nodeRequirement)
}

console.log(`\n===== 环境契约：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
