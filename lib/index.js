/**
 * dsh-doc-kit — host 半区（最小实现）。
 *
 * 只做两件事：
 *   ① 注册**只读**工具 doc_lint（体检）
 *   ② 把包内 skills/ 同步进技能库（技能随包，改仓库那份才生效）
 *
 * 明确不做：不注入任何 prompt / 不注册 client / 不调 LLM / 无定时器 / 不自动改写任何文件。
 * 注入层（L0/L1）是用户自己的 AGENTS.md，本插件不碰。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { docLint, DEFAULTS } from './lint.js'

const PkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const name = 'dsh-doc-kit'
// cordis 要求显式声明服务依赖：不写 inject 时 ctx.tools 取不到（报 "cannot get property ... without inject"）
export const inject = ['tools']

/** 把包内 skills/<name>/SKILL.md 同步到技能库；内容不同就覆写（仓库是源头）。 */
export function syncSkills(skillDir, srcDir = join(PkgRoot, 'skills')) {
  if (!existsSync(srcDir)) return '包内没有 skills/'
  const out = []
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const from = join(srcDir, entry.name, 'SKILL.md')
    if (!existsSync(from)) continue
    const to = join(skillDir, entry.name, 'SKILL.md')
    const next = readFileSync(from, 'utf8')
    let cur = null
    try { cur = readFileSync(to, 'utf8') } catch { /* 首次 */ }
    if (cur === next) { out.push(entry.name + ':unchanged'); continue }
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, next)
    out.push(entry.name + ':' + (cur === null ? 'installed' : 'updated'))
  }
  return out.join(', ') || '无技能可同步'
}

export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const skillDir = config.skillDir || join(homedir(), '.agents', 'skills')
  const base = {
    l0: config.l0 || join(dshHome, 'AGENTS.md'),
    workspaceRoot: config.workspaceRoot || null,   // 缺省在 execute 里按会话 cwd 解析
    l0Quota: config.l0Quota ?? DEFAULTS.l0Quota,
    l1Quota: config.l1Quota ?? DEFAULTS.l1Quota,
  }
  ctx.logger?.info?.('[dsh-doc-kit] skill sync → ' + syncSkills(skillDir))

  ctx.effect(() => ctx.tools.register({
    name: 'doc_lint',
    description: '文档体系体检（只读）：注入层配额（L0 ≤2KB / L1 ≤4KB）、被禁的决策史措辞、L1 索引里点名的文档是否存在、治理文件是否已进 git。写或改文档、整理文档、怀疑索引漂移时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        l0: { type: 'string', description: '可选：覆盖 L0（全局 AGENTS.md）路径' },
        workspaceRoot: { type: 'string', description: '可选：覆盖工作区根目录' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, report: { type: 'string' } }, required: ['ok', 'report'] },
      render: (_a, v) => [{ type: 'text', text: v.report }],
    },
    async execute(args, exec) {
      // 工作区根：显式参数 → 会话 cwd → 配置 → 进程 cwd（不写死任何路径）
      const workspaceRoot = (args && args.workspaceRoot) || exec?.agent?.session?.header?.cwd || base.workspaceRoot || process.cwd()
      const r = docLint({ ...base, workspaceRoot, ...(args && args.l0 ? { l0: args.l0 } : {}) })
      return { ok: r.ok, report: r.report }
    },
  }), 'dsh-doc-kit: doc_lint')
}

