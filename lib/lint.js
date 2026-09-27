/**
 * dsh-doc-kit — 文档体系体检（只读、零依赖）。
 *
 * 四项检查：
 *   1. 配额（硬）—— L0 / L1 字节数不得超过自律配额，超了说明有人在往注入层塞东西
 *   2. 被禁段落（硬）—— 注入层不得出现「曾用 / 已废弃 / 已被推翻 / 别再试」这类决策史
 *   3. 索引路径（软）—— L1 表里点名的文档是否真的存在
 *   4. git（软）—— 治理文件是否已进 git（未跟踪 = 没有 diff 历史，漂移无从发现）
 *
 * 硬检查决定 ok；软检查只产出 findings 供人/模型判断（例如 refs/ 那行本来就指向不存在的文件）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

export const DEFAULTS = {
  l0: '~/.dsh/AGENTS.md',
  workspaceRoot: null,   // 必须在调用处解析（会话 cwd / 配置），不写死任何本机路径
  l0Quota: 2048,
  l1Quota: 4096,
}

const expand = (p) => (typeof p === 'string' && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
const bytes = (p) => { try { return statSync(p).size } catch { return null } }
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** 决策史/过程凭证类措辞——注入层不该出现。 */
export const BANNED = /曾用|已废弃|已被推翻|别再试|不再使用/

/**
 * 从索引文本里抽「被点名的路径」。
 * 规则：跳过 `<占位>` 与以 / 结尾的目录；含 / 的当作工作区相对路径，否则相对该行的基（首列目录）。
 * 另外跳过**描述他人文件惯例**的单元格（含「第三方 / 自带 / 示例」）——那不是具体文件，例如 `refs/` 行里的 `AGENTS.md`。
 */
const PATTERN_CELL = /第三方|自带|示例/
export function extractIndexPaths(text, workspaceRoot) {
  if (!text) return []
  const found = new Set()
  for (const line of text.split('\n')) {
    if (!line.includes('`')) continue
    const isRow = line.trim().startsWith('|')
    const cells = isRow ? line.split('|').slice(1, -1).map((c) => c.trim()) : [line]
    const base = isRow && /`([^`]+)\//.test(cells[0] || '') ? [...(cells[0] || '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())[0] : ''
    for (const cell of cells) {
      if (PATTERN_CELL.test(cell)) continue
      for (const t of [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())) {
        if (!t || t.includes('<') || t.endsWith('/')) continue
        if (!/[.](md|mjs|json|ya?ml)$/.test(t)) continue
        found.add(t.includes('/') || t.startsWith('~') ? join(workspaceRoot, t) : join(workspaceRoot, base, t))
      }
    }
  }
  return [...found].map(expand)
}

/** git 是否跟踪了该文件（未跟踪 = '??'）。git 不可用时返回 null。 */
export function gitTracked(path, cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    })
    if (!out.trim()) return true
    return !out.trim().split('\n').every((l) => l.startsWith('??'))
  } catch { return null }
}

/** 跑全部检查，返回 { ok, checks, report }。 */
export function docLint(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const l0 = expand(cfg.l0)
  const ws = expand(cfg.workspaceRoot)
  const l1 = cfg.l1 || join(ws, 'AGENTS.md')
  const l0Text = read(l0)
  const l1Text = read(l1)
  const checks = []

  // 1 配额
  const l0Size = bytes(l0)
  const l1Size = bytes(l1)
  const overL0 = l0Size !== null && l0Size > cfg.l0Quota
  const overL1 = l1Size !== null && l1Size > cfg.l1Quota
  checks.push({
    id: 'quota', level: 'hard', ok: !overL0 && !overL1,
    detail: `L0 ${l0Size ?? '缺失'} B / 配额 ${cfg.l0Quota}；L1 ${l1Size ?? '缺失'} B / 配额 ${cfg.l1Quota}`,
  })

  // 2 被禁段落
  const dirty = []
  for (const [name, text] of [['L0', l0Text], ['L1', l1Text]]) {
    if (!text) continue
    text.split('\n').forEach((line, i) => { if (BANNED.test(line)) dirty.push(`${name}:${i + 1} ${line.trim().slice(0, 60)}`) })
  }
  checks.push({ id: 'banned', level: 'hard', ok: dirty.length === 0, detail: dirty.length ? dirty.join(' | ') : '无决策史措辞' })

  // 3 索引路径
  const missing = extractIndexPaths(l1Text, ws).filter((p) => !existsSync(p))
  checks.push({
    id: 'index', level: 'soft', ok: missing.length === 0,
    detail: missing.length ? missing.map((p) => p.replace(ws + '/', '')).join(' | ') : `${extractIndexPaths(l1Text, ws).length} 条路径全部存在`,
  })

  // 4 git（只看工作区内的治理文件；L0 在 ~/.dsh，通常不在任何仓库里，跳过不算失败）
  const targets = [l1, join(ws, 'docs/machine.md'), join(ws, 'docs/workflow.md')].filter((p) => existsSync(p))
  const untracked = []
  let probed = 0
  for (const p of targets) {
    const t = gitTracked(p, ws)
    if (t === null) continue
    probed++
    if (t === false) untracked.push(p.replace(ws + '/', '').replace(homedir(), '~'))
  }
  checks.push({
    id: 'git', level: 'soft', ok: untracked.length === 0 && probed > 0,
    detail: probed === 0 ? (targets.length ? '不在仓库内或 git 不可用，跳过' : '无可检目标（L1 与 docs/ 均不存在）')
      : (untracked.length ? '未跟踪：' + untracked.join(' | ') : `已跟踪（${probed} 个）`),
  })

  const hardFail = checks.filter((c) => c.level === 'hard' && !c.ok)
  const softFail = checks.filter((c) => c.level === 'soft' && !c.ok)
  const mark = (c) => (c.ok ? 'PASS' : c.level === 'hard' ? 'FAIL' : 'WARN')
  const report = [
    `doc_lint：${hardFail.length === 0 ? '通过' : hardFail.length + ' 项硬失败'}${softFail.length ? `（另有 ${softFail.length} 项提示）` : ''}`,
    ...checks.map((c) => `  [${mark(c)}] ${c.id}：${c.detail}`),
  ].join('\n')

  return { ok: hardFail.length === 0, checks, report }
}
