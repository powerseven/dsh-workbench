/**
 * 构建产物测试。
 *
 * 守的是一类「不报错但完全不工作」的失效：client 半身如果没被无条件导出，
 * 浏览器里插件会静默不注册——没有任何错误日志，面板就是不出现。
 * 这类问题靠人眼 review 很容易漏，所以直接对产物断言。
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')

let client = ''
let host = ''

before(() => {
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe' })
  client = readFileSync(join(lib, 'client.js'), 'utf8')
  host = readFileSync(join(lib, 'index.js'), 'utf8')
})

test('build 产出 host 与 client 三个文件', () => {
  for (const f of ['index.js', 'store.js', 'client.js']) {
    assert.ok(existsSync(join(lib, f)), '缺少构建产物 ' + f)
  }
})

test('client bundle 用正确的插件 id 包装成 C6 模块', () => {
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{ id: "dsh-workbench", factory: \(require\) =>/)
  assert.match(client, /return module\.exports; \} \}\);\n$/, 'bundle 必须以工厂返回收尾')
})

test('client 无条件导出 name/inject/apply（否则面板静默不注册）', () => {
  assert.match(client, /module\.exports = \{ name: 'dsh-workbench-client'/)
  assert.match(client, /inject: \['slots', 'betterSidebar'\]/)
  assert.match(client, /apply: apply \}/)
  // 导出语句前面不能有 window 守卫
  assert.doesNotMatch(client, /if \(typeof window === 'undefined'[\s\S]{0,200}module\.exports = \{ name:/)
})

test('client bundle 内联了纯逻辑函数（UI 直接引用闭包里的名字）', () => {
  for (const fn of [
    'function summarize(', 'function sortNodes(', 'function toggleStatus(', 'function pct(',
    'function priorityLabel(', 'function nextPriority(', 'function delegateText(',
    'function flattenNodes(', 'function focusList(', 'function filterCounts(',
    'function nodeType(', 'function progressOf(', 'function moveTargets(',
    'function inboxOf(', 'function planNodes(', 'function childrenOf(',
    'function evidenceLabel(', 'function evidenceList(', 'function unverifiedOf(',
    'function paceText(',
  ]) {
    assert.ok(client.includes(fn), 'bundle 缺少内联函数 ' + fn)
  }
})

test('client bundle 不引入构建期依赖（只用 require 取 React）', () => {
  const requires = [...client.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
  assert.deepEqual([...new Set(requires)], ['react'], '客户端只应 require react')
})

test('host 半身导出 name/inject/apply', () => {
  assert.match(host, /export const name = 'dsh-workbench'/)
  assert.match(host, /export const inject = \['tools'\]/)
  assert.match(host, /export function apply\(ctx\)/)
})

test('host 半身注册了完整的 plan_* 工具集（节点模型）', () => {
  for (const tool of [
    'plan_show', 'plan_node_add', 'plan_node_set', 'plan_node_move', 'plan_node_remove',
    'plan_todo_set', 'plan_priority_set',
    'plan_delegate_set', 'plan_delegate_receipt', 'plan_delegated',
    'plan_snapshot', 'plan_history', 'plan_restore',
  ]) {
    assert.ok(host.includes("'" + tool + "'"), 'host 缺少工具 ' + tool)
  }
})

test('host 半身暴露 /api/workbench 数据面', () => {
  assert.match(host, /'\/api\/workbench' \+ path/)
  for (const route of ['/get', '/todo-set', '/node-add', '/node-set', '/node-move', '/node-remove', '/init', '/snapshot', '/history']) {
    assert.ok(host.includes("route('" + route + "'"), 'host 缺少路由 ' + route)
  }
})

test('cordis.patch.yml 用 insert 且 id 与包名一致', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-workbench/)
  assert.match(patch, /name: 'dsh-workbench'/)
})

test('package.json 声明的入口文件真实存在', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const [k, v] of Object.entries(pkg.exports)) {
    const p = typeof v === 'string' ? v : v.default
    assert.ok(existsSync(join(root, p)), 'exports[' + k + '] 指向不存在的文件：' + p)
  }
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'bundle patch 文件不存在')
})
