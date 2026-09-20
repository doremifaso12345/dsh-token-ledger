/**
 * 真实 profile 解析验证。
 *
 * 在 profile 目录下按宿主的解析规则 import 插件，验证：
 * 1. 裸名 "dsh-token-ledger" 能解析到包（宿主 loader 就是这么 import 的）
 * 2. 导出了 loader 需要的 name / apply / inject
 * 3. "dsh-token-ledger/client" 能解析（客户端半的 exports 子路径）
 * 4. dsh.bundle.patch 指向的补丁文件存在且是合法 YAML 数组
 * 5. dsh.client 声明合法且 inject 里的模块 id 都真实存在
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const PROFILE = 'C:/Users/Eric/AppData/Roaming/dsh-desktop/harness/profiles/web'

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

// 模拟宿主：从 profile 目录按包名解析
const require = createRequire(path.join(PROFILE, 'index.js'))

console.log('\n[1] 裸包名解析（宿主 loader 的 import 路径）')
let resolvedMain
try {
  resolvedMain = require.resolve('dsh-token-ledger')
  ok(true, 'dsh-token-ledger 可解析')
  console.log('  info -> ' + resolvedMain)
} catch (e) {
  ok(false, 'dsh-token-ledger 可解析', String(e.message))
}
let resolvedClient
try {
  resolvedClient = require.resolve('dsh-token-ledger/client')
  ok(true, 'dsh-token-ledger/client 可解析')
  console.log('  info -> ' + resolvedClient)
} catch (e) {
  ok(false, 'dsh-token-ledger/client 可解析', String(e.message))
}

console.log('\n[2] 宿主半导出契约')
{
  const mod = await import(new URL('file:///' + resolvedMain.replace(/\\/g, '/')).href)
  ok(typeof mod.apply === 'function', '导出 apply 函数')
  ok(Array.isArray(mod.inject), '导出 inject 数组', mod.inject)
  ok(typeof mod.name === 'string' && mod.name.length > 0, '导出 name', mod.name)
}

console.log('\n[3] 客户端半导出契约')
{
  const src = fs.readFileSync(resolvedClient, 'utf8')
  ok(src.includes('window.__ModuleLoader__.load'), '注册到 __ModuleLoader__')
  ok(src.includes('exports.apply'), '导出 apply')
  ok(src.includes('exports.inject'), '导出 inject')
  // 提取 inject 数组内容
  const m = src.match(/const inject = \[([^\]]*)\]/)
  ok(m !== null, '能定位 inject 声明')
  if (m !== null) {
    const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    ok(names.length > 0, 'inject 非空', names)
    ok(names.includes('slots'), 'inject 含 slots（注册 UI 的必需服务）', names)
    // 逐个验证这些服务确实存在于宿主客户端
    for (const n of names) {
      // slots / locale 是客户端服务名，不是包名；验证提供它们的包存在
      const provider = { slots: '@deepseek-ai/dsh-client-ui-slots', locale: '@deepseek-ai/dsh-client-locale' }[n]
      if (provider === undefined) {
        ok(false, `服务 ${n} 有已知提供者`, n)
        continue
      }
      let found = false
      try {
        require.resolve(provider)
        found = true
      } catch {}
      ok(found, `服务 ${n} 的提供者 ${provider} 存在`)
    }
  }
}

console.log('\n[4] dsh 元数据')
{
  const pkgPath = path.join(path.dirname(resolvedMain), '..', 'package.json')
  const pj = JSON.parse(fs.readFileSync(require.resolve('dsh-token-ledger/package.json'), 'utf8'))
  ok(pj.dsh !== undefined, 'dsh 字段存在')
  ok(pj.dsh.bundle && typeof pj.dsh.bundle.patch === 'string', 'dsh.bundle.patch 已声明', pj.dsh.bundle)
  ok(pj.dsh.client && pj.dsh.client.platform === 'web', 'dsh.client.platform = web', pj.dsh.client && pj.dsh.client.platform)
  ok(Array.isArray(pj.dsh.client.inject), 'dsh.client.inject 是数组', pj.dsh.client.inject)
  // 每个 client inject 说明符必须指向真实存在的包（客户端图会校验）
  for (const spec of pj.dsh.client.inject) {
    let found = false
    try {
      require.resolve(spec + '/package.json')
      found = true
    } catch {}
    ok(found, `client.inject 说明符存在: ${spec}`)
  }

  const patchPath = path.join(path.dirname(require.resolve('dsh-token-ledger/package.json')), pj.dsh.bundle.patch)
  ok(fs.existsSync(patchPath), '补丁文件存在', patchPath)
  const patchText = fs.readFileSync(patchPath, 'utf8')
  ok(patchText.includes('insert:'), '补丁含 insert 列表')
  ok(patchText.includes('dsh-token-ledger'), '补丁插入了本插件')
}

console.log('\n[5] profile 装配包含本插件')
{
  const pj = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'))
  ok(pj.dependencies['dsh-token-ledger'] !== undefined, '在 profile dependencies 中', pj.dependencies['dsh-token-ledger'])
  ok(pj.dsh.profile.bundles.includes('dsh-token-ledger'), '在 profile bundles 中')
}

console.log(`\n===== profile 解析结果：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
