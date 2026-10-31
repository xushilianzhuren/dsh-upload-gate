/**
 * 上载闸 · 插件（Host 侧，零依赖，无构建）
 *
 * 护栏前置令：出口会产生不可回滚后果的强能力（对外发信/动实盘/上云/删正本），
 * 出口前必须先有护栏（限额／指纹／回滚位）。本插件只做**出厂预检**与**凭据面盘点**：
 * 不代传、不读密钥值、不发网络请求——把"没有护栏就上云"这条路直接堵死。
 *
 * @module dsh-upload-gate
 */

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ql-upload'

export const inject = ['systemPrompt', 'tools']

const SECTION_NAME = 'ql:upload'

const DEFAULTS = Object.freeze({ order: 140, tool: true, enabled: true })

/** 文件名禁传标记（命中即 BLOCK，不看内容）。 */
const FORBIDDEN_NAMES = ['.env', 'id_rsa', '凭据', 'secret', 'credentials', '.pem', '.key']

/** 内容指纹（只报类别，不回显命中原值）。 */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥块'],
  [/\b(sk-[A-Za-z0-9]{12,}|AKID[A-Za-z0-9]{10,})\b/, '疑似云密钥'],
  [/(secret|token|password|passwd|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i, '明文密钥赋值'],
  [/\b\d{17}[\dXx]\b/, '疑似身份证号'],
]

/** 凭据面候选（只查存在性，不读值）。 */
const CRED_ENV = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENTCLOUD_SECRET_ID']
const CRED_FILES = ['scripts/三节点指挥棒.py', 'scripts/凭据固化台账.py', 'scripts/裁撤归置/Smart Agent文明·原节点疆域.md']

function normalizeConfig(config) {
  const raw = config ?? {}
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('ql-upload: config.enabled must be a boolean')
  if (raw.tool !== undefined && typeof raw.tool !== 'boolean') throw new Error('ql-upload: config.tool must be a boolean')
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) throw new Error('ql-upload: config.order must be a finite number')
  if (raw.root !== undefined && (typeof raw.root !== 'string' || raw.root.trim() === '')) throw new Error('ql-upload: config.root must be a non-empty path string')
  return {
    order: raw.order ?? DEFAULTS.order,
    tool: raw.tool ?? DEFAULTS.tool,
    root: raw.root === undefined ? undefined : raw.root.trim(),
    enabled: raw.enabled ?? DEFAULTS.enabled,
  }
}

function isWorkspace(dir) {
  try {
    return existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, 'scripts'))
      && (existsSync(join(dir, 'SOUL.md')) || existsSync(join(dir, 'USER.md')))
  } catch {
    return false
  }
}

function findRoot(configured) {
  const candidates = []
  if (configured !== undefined) candidates.push(configured)
  try {
    candidates.push(dirname(dirname(fileURLToPath(import.meta.url))))
  } catch {
    /* 非文件装法 */
  }
  let dir = process.cwd()
  for (let hop = 0; hop < 6; hop += 1) {
    candidates.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push('~//Smart Agentharness')
  for (const candidate of candidates) {
    if (isWorkspace(candidate)) return candidate
  }
  return candidates[0]
}

function clip(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

async function preflight(root, target) {
  const path = target.startsWith('/') ? target : join(root, target)
  const lines = ['【上载闸·出厂三检】', `目标：${path}`]
  let blocked = false
  let size = 0
  try {
    const info = await stat(path)
    size = info.size
    lines.push(`①存在：✅ ${(size / 1024).toFixed(1)} KB`)
    if (size === 0) { blocked = true; lines.push('   空文件＝打回') }
  } catch {
    return '【上载闸】❌ 目标不存在，拒绝出厂：' + target
  }
  const base = path.split('/').pop() ?? ''
  const nameHit = FORBIDDEN_NAMES.find(word => base.toLowerCase().includes(word.toLowerCase()))
  if (nameHit !== undefined) { blocked = true; lines.push(`②机密：❌ 文件名含禁传标记「${nameHit}」`) }
  else lines.push('②机密：文件名无禁传标记')
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = ''
  }
  const secretHits = SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
  if (secretHits.length > 0) { blocked = true; lines.push(`   内容命中：${secretHits.join('、')}（已命中即禁传，改动后重检）`) }
  else if (text !== '') lines.push('   内容：无密钥/证件号指纹')
  lines.push(`③体量：${size > 50 * 1024 * 1024 ? '⚠ 超 50MB——上载前分包（单包过大易断）' : '常规'}`)
  lines.push('', '上载前四问（逐条答"是"才准出）：')
  lines.push('  · 限额护栏在？（单次/累计上限写了吗）')
  lines.push('  · 指纹护栏在？（上载留痕可审计吗）')
  lines.push('  · 回滚位在？（原件仍在本地/云上可回吗）')
  lines.push('  · 机密零外发？（本件无密钥/证件号/主人私域）')
  lines.push('', blocked ? '判定：BLOCK（禁出厂）' : '判定：PASS（三检过；四问仍需人答）')
  return lines.join('\n')
}

async function credentialSurface(root) {
  const lines = ['【凭据面·只报有无，不读值】']
  const envFound = CRED_ENV.filter(name => typeof process.env[name] === 'string' && process.env[name] !== '')
  lines.push(`环境变量：${envFound.length > 0 ? '有 ' + envFound.length + ' 个（' + envFound.join('、') + '）' : '无'}`)
  for (const rel of CRED_FILES) {
    lines.push(`  ${rel}：${existsSync(join(root, rel)) ? '在盘（值未读）' : '缺件'}`)
  }
  lines.push('', '结论：凭据面只说明"有没有"，不说明"能不能用"——真上载须主人当次授权＋护栏在位。')
  lines.push('本插件不代传：上传动作请走主人批准的路径（限额+回滚位+留痕）。')
  return lines.join('\n')
}

function renderSection() {
  return [
    '## 上载闸令 · 常驻（无护栏的强能力，禁出厂）',
    '',
    '**能力强不是缓铸护栏的理由，是必须先铸的理由**。凡出口会产生不可回滚后果的动作'
      + '（花钱／对外发信／动实盘／改在役正本／删正本数据／上云），先有护栏，再谈出口。',
    '',
    '**一、护栏三型（缺一不叫护栏）**',
    '①限额——单次与累计上限写死；②指纹——每次动作留痕可审计；③回滚位——原件在本地或云上可回。',
    '',
    '**二、出厂三检**：存在与体量／文件名禁传标记／内容密钥与证件号指纹。任一不过＝BLOCK。',
    '',
    '**三、机密零外发**：密钥、证件号、主人私域信息不进任何上传件；命中即禁传，改动后重检。',
    '',
    '**四、上载即留痕**：谁在什么时候把什么传到了哪里，必须有一行账——无账的上载视同没护栏。',
    '',
    '**判据**：动手上载前自问"限额、指纹、回滚位、机密四问答得齐吗"——答不齐＝禁出厂。',
  ].join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('ql-upload：主开关关着，未挂载')
    return
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.order,
    text: () => renderSection(),
  }), 'ql-upload.section()')

  if (cfg.tool) {
    ctx.effect(() => ctx.tools.register({
      name: 'ql_upload',
      description: '上载闸：预检（对目标文件跑存在/机密/体量三检，出 PASS 或 BLOCK 与上载前四问）、'
        + '凭据面（只报云凭据"有没有"，不读值）。不代传、不联网。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['预检', '凭据面'],
            description: '要执行的动作。',
          },
          query: { type: 'string', description: '预检＝待发文件路径（相对工作区或绝对路径）。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args) => {
        const root = findRoot(cfg.root)
        const action = typeof args?.action === 'string' ? args.action : '预检'
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        try {
          if (action === '凭据面') return { report: await credentialSurface(root) }
          if (query === '') return { report: '预检需要 query（待发文件路径）。' }
          return { report: await preflight(root, query) }
        } catch (error) {
          return { report: `上载闸内部错：${clip(error?.message ?? error, 200)}` }
        }
      },
    }), 'ql-upload.tool()')
  }

  ctx.logger?.info?.('ql-upload：区块 %s 已注册（order=%d）', SECTION_NAME, cfg.order)
}
