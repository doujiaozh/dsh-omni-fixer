/**
 * omni_heal —— 确定性规则引擎（本地秒修）。
 *
 * 流水线的第一道修复通道：对"可证明、可逆、可验证"的机械错误
 * 直接给出补丁，零 token、零延迟、零幻觉。
 * 规则给出的一切补丁仍必须通过 omni_verify 的物理闸门才落盘，
 * 错了会被打回并升级到模型通道——所以这里敢于用"最佳猜测"。
 *
 * 规则全集：
 *   1. fullwidth-char   全角标点 → ASCII（位置精确，天然跳过字符串/注释）
 *   2. unclosed-bracket 未闭合括号 → 在文件末尾从内到外补齐闭合符
 *   3. py/missing-colon 复合语句缺冒号 → 行尾补 ':'
 *   4. tsc "'X' expected" → 在报错位置插入 X
 */
import type { FixContract } from '../core/types.js'
import { splitLines } from '../core/util.js'
import { analyzeJs, type BracketPos } from '../scan/ast-js.js'
import { analyzePy } from '../scan/ast-py.js'

export interface RuleFix {
  patch: string
  note: string
  /** 命中的规则名（战报里展示"规则引擎参战"）。 */
  firedRules: string[]
}

const SUPPORTED_AST_RULES = new Set([
  'js/fullwidth-char',
  'js/unclosed-bracket',
  'py/fullwidth-char',
  'py/unclosed-bracket',
  'py/missing-colon',
])

const TSC_EXPECTED_RE = /^- \[tsc (TS\d+)\] (\d+):(\d+) '([^']*)' expected\./gm

export function ruleEngineCanHandle(contract: FixContract): boolean {
  if (contract.errorRules.some((r) => SUPPORTED_AST_RULES.has(r))) return true
  TSC_EXPECTED_RE.lastIndex = 0
  return TSC_EXPECTED_RE.test(contract.errorText)
}

const CLOSE_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** 在 content 上应用全部可执行的规则，返回新内容；无规则命中返回 null。 */
export function applyRules(contract: FixContract, content: string): RuleFix | null {
  const fired: string[] = []
  let working = content
  const lang: 'js' | 'py' = contract.language === 'py' ? 'py' : 'js'

  // ---- 规则 1：全角标点 → ASCII ----
  if (
    contract.errorRules.includes('js/fullwidth-char') ||
    contract.errorRules.includes('py/fullwidth-char')
  ) {
    const rewritten = rewriteFullwidth(contract, working, lang)
    if (rewritten) {
      working = rewritten
      fired.push('fullwidth→ascii')
    }
  }

  // ---- 规则 2：未闭合括号 → EOF 补齐闭合符 ----
  if (
    contract.errorRules.includes('js/unclosed-bracket') ||
    contract.errorRules.includes('py/unclosed-bracket')
  ) {
    const fix = appendClosers(working, lang)
    if (fix) {
      working = fix
      fired.push('unclosed-bracket→closers')
    }
  }

  // ---- 规则 3：Python 复合语句缺冒号 ----
  if (contract.errorRules.includes('py/missing-colon')) {
    const fix = appendMissingColons(contract, working)
    if (fix) {
      working = fix
      fired.push('missing-colon→:')
    }
  }

  // ---- 规则 4：tsc "'X' expected" ----
  const insertions = parseTscExpectedInsertions(contract)
  if (insertions.length > 0) {
    let s = working
    for (const ins of insertions) {
      const ls = splitLines(s)
      const idx = ins.line - 1
      if (idx < 0 || idx >= ls.length) continue
      const line = ls[idx]!
      const col = Math.max(0, Math.min(line.length, ins.col - 1))
      ls[idx] = line.slice(0, col) + ins.char + line.slice(col)
      s = ls.join('\n') + '\n'
      fired.push(`tsc-expected→${ins.char}@${ins.line}:${ins.col}`)
    }
    working = s
  }

  if (fired.length === 0) return null
  return {
    patch: working.endsWith('\n') ? working : working + '\n',
    note: fired.join(', '),
    firedRules: fired,
  }
}

/**
 * 全角 → ASCII：用 AST 扫描器的 fullwidthByLine（只记录 code 模式下的全角字符，
 * 字符串与注释内的中文标点天然被跳过）做精确位置替换。
 */
function rewriteFullwidth(contract: FixContract, content: string, lang: 'js' | 'py'): string | null {
  const analysis = lang === 'js' ? analyzeJs(content, contract.file) : analyzePy(content, contract.file)
  const byLine = analysis.fullwidthByLine
  if (byLine.size === 0) return null
  const lines = splitLines(content)
  for (const [ln, items] of byLine) {
    const idx = ln - 1
    if (idx < 0 || idx >= lines.length) continue
    let line = lines[idx]!
    for (const item of [...items].reverse()) {
      const colIdx = item.col - 1
      if (colIdx >= 0 && colIdx < line.length && line[colIdx] === item.ch) {
        line = line.slice(0, colIdx) + item.replacement + line.slice(colIdx + 1)
      }
    }
    lines[idx] = line
  }
  return lines.join('\n') + (content.endsWith('\n') || lines.length === 0 ? '\n' : '')
}

/**
 * 未闭合括号修复。两种落点：
 * 1) opener 所在行、其后面还跟着 `{`（块开始）——说明作者本意是“先闭括号再开块”
 *    （典型笔误 `function add(a, b {`），把闭合符插到该 `{` 之前，得到
 *    `function add(a, b) {`；
 * 2) 其余情况（`foo(1,\n  2` 这类跨行续接）——从内到外拼接闭合符，
 *    追加到文件最后一个有内容的行尾。
 */
function appendClosers(content: string, lang: 'js' | 'py'): string | null {
  const analysis = lang === 'js' ? analyzeJs(content, '<closers>') : analyzePy(content, '<closers>')
  if (analysis.unclosedOpeners.length === 0) return null
  const lines = splitLines(content)

  // 按所在行分组（数组顺序即入栈顺序：前=外层，后=内层）
  const byLine = new Map<number, BracketPos[]>()
  for (const o of analysis.unclosedOpeners) {
    const arr = byLine.get(o.line)
    if (arr) arr.push(o)
    else byLine.set(o.line, [o])
  }
  const closersOf = (arr: BracketPos[]): string =>
    arr
      .slice()
      .reverse() // 从内到外
      .map((o) => CLOSE_OF[o.ch] ?? '')
      .join('')

  let eofClosers = ''
  for (const [line, arr] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const idx = line - 1
    if (idx < 0 || idx >= lines.length) continue
    const raw = lines[idx]!
    // 从最外层 opener 之后开始找块起始 `{`；该 `{` 本身也是本行未闭合 opener
    // （`foo({`）时不适用插点，整组走 EOF 追加。
    const start = (arr[0]?.col ?? 1) - 1
    const after = raw.slice(start + 1)
    const braceRel = after.indexOf('{')
    const groupHasBrace = arr.some((o) => o.ch === '{')
    if (braceRel >= 0 && !groupHasBrace) {
      const absBrace = start + 1 + braceRel
      lines[idx] = raw.slice(0, absBrace) + closersOf(arr) + raw.slice(absBrace)
    } else {
      eofClosers += closersOf(arr)
    }
  }
  if (eofClosers) {
    let lastIdx = lines.length - 1
    while (lastIdx > 0 && lines[lastIdx]!.trim() === '') lastIdx--
    if (lastIdx < 0) return null
    lines[lastIdx] = lines[lastIdx]!.replace(/\s+$/, '') + eofClosers
  }
  return lines.join('\n') + (content.endsWith('\n') ? '\n' : '')
}

/** Python 缺冒号：在 diag 所在行尾补 ':'。 */
function appendMissingColons(contract: FixContract, content: string): string | null {
  // 列号可能为 null（AST 扫描器只定位到行），位置段用 \S* 容错；
  // 规则名带 source 前缀（如 "ast py/missing-colon"），用 [^\]]* 通配
  const re = /- \[[^\]]*py\/missing-colon\] (\d+):\S* /gm
  const lines = splitLines(content)
  let touched = false
  for (const m of contract.errorText.matchAll(re)) {
    const idx = Number(m[1]!) - 1
    if (idx < 0 || idx >= lines.length) continue
    const line = lines[idx]!
    if (line.includes(':')) continue
    lines[idx] = line.replace(/\s+$/, '') + ':'
    touched = true
  }
  if (!touched) return null
  return lines.join('\n') + (content.endsWith('\n') ? '\n' : '')
}

interface TscInsertion {
  line: number
  col: number
  char: string
}

function parseTscExpectedInsertions(contract: FixContract): TscInsertion[] {
  const out: TscInsertion[] = []
  for (const m of contract.errorText.matchAll(new RegExp(TSC_EXPECTED_RE.source, 'g'))) {
    out.push({ line: Number(m[2]), col: Number(m[3]), char: m[4]! })
  }
  return out
}
