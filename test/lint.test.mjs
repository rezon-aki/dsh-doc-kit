import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { docLint, extractIndexPaths, gitTracked } from '../lib/lint.js'

function fixture({ l0 = '# 全局\n', l1 = '# 索引\n', files = {} } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'dockit-'))
  const l0p = join(ws, 'AGENTS.l0.md')
  writeFileSync(l0p, l0)
  writeFileSync(join(ws, 'AGENTS.md'), l1)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(ws, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return { ws, l0p }
}

test('extractIndexPaths：表行按首列目录作基，跳过占位与目录', () => {
  const l1 = [
    '| 位置 | 真源 | 何时读 |',
    '|---|---|---|',
    '| `webapp/` | 域通用 `webapp/CONTEXT.md`；各插件自有 `CONTEXT.md`、`docs/` | 改前 |',
    '| `refs/` | 第三方仓（自带 `AGENTS.md`） | 只读 |',
    '- 环境：`docs/setup.md`',
    '| `x/` | `<项目>/AGENTS.md` | 占位应跳过 |',
  ].join('\n')
  const got = extractIndexPaths(l1, '/ws').map((p) => p.replace('/ws/', ''))
  // refs 那行描述的是第三方仓惯例（含「第三方/自带」）→ 视为模式而非具体文件，应跳过
  assert.deepEqual(got.sort(), ['webapp/CONTEXT.md', 'docs/setup.md'].sort())
})

test('健康夹具：全通过', () => {
  const f = fixture({ l1: '| `docs/` | 方法 `docs/setup.md` | 按需 |\n', files: { 'docs/setup.md': 'x' } })
  const r = docLint({ l0: f.l0p, workspaceRoot: f.ws })
  assert.equal(r.ok, true, r.report)
  assert.match(r.report, /doc_lint：通过/)
})

test('配额超限：硬失败', () => {
  const f = fixture({ l0: 'x'.repeat(4000) })
  const r = docLint({ l0: f.l0p, workspaceRoot: f.ws })
  assert.equal(r.ok, false)
  assert.match(r.report, /\[FAIL\] quota/)
})

test('被禁段落：硬失败', () => {
  const f = fixture({ l1: '# 索引\n曾用旧方案\n' })
  const r = docLint({ l0: f.l0p, workspaceRoot: f.ws })
  assert.equal(r.ok, false)
  assert.match(r.report, /\[FAIL\] banned/)
})

test('索引缺文件：只提示，不判失败', () => {
  const f = fixture({ l1: '| `docs/` | 方法 `docs/nope.md` | 按需 |\n' })
  const r = docLint({ l0: f.l0p, workspaceRoot: f.ws })
  assert.equal(r.ok, true, r.report)
  assert.match(r.report, /\[WARN\] index/)
})

test('gitTracked：非 git 目录返回 null（优雅降级）', () => {
  const f = fixture({})
  assert.equal(gitTracked(join(f.ws, 'AGENTS.md'), f.ws), null)
})
