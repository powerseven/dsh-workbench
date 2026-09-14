/**
 * dsh-workbench 构建脚本（零依赖）：
 *
 *   - Host 半身：src/index.js、src/store.js 是纯 ESM，直接拷贝到 lib/；
 *   - Client 半身：src/client/logic.cjs（纯逻辑）先内联，再内联
 *     src/client/index.js（UI），两者共享同一个工厂闭包作用域，
 *     整体包装为 DSH client-modules 的 C6 bundle（window.__ModuleLoader__.load）。
 *
 * 不做压缩、不做转译——插件体积小，可读的产物更利于排查问题。
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')
mkdirSync(lib, { recursive: true })

// ---- Host 半身 ----
const HOST_FILES = ['index.js', 'store.js']
for (const file of HOST_FILES) {
  copyFileSync(join(root, 'src', file), join(lib, file))
}

// ---- Client 半身（C6 bundle）----
const logicSrc = readFileSync(join(root, 'src', 'client', 'logic.cjs'), 'utf8')
const clientSrc = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
const banner = 'window.__ModuleLoader__.load({ id: "dsh-workbench", factory: (require) => { var module = { exports: {} }; var exports = module.exports;\n'
const footer = '\nreturn module.exports; } });\n'
writeFileSync(join(lib, 'client.js'), banner + logicSrc + '\n' + clientSrc + footer)

console.log('[dsh-workbench] build ok -> lib/' + ['index.js', 'store.js', 'client.js'].join(', lib/'))
