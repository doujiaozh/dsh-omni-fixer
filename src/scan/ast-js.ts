/**
 * omni_scan —— JS/TS 家族零依赖词法扫描器。
 *
 * 不依赖任何 npm 解析器：一个手写的逐字符 NDFA 同时产出
 *   1. 诊断（括号失衡、未闭合字符串/模板/注释、全角标点）
 *   2. 代码跨度（字符串/注释/模板），供规则引擎做"安全替换"
 *
 * 准确性目标：覆盖 90% 的常见语法错误；剩下的交给宿主工具链
 * （node --check / tsc）兜底——两者在本流水线里是验证闸门。
 */
import type { Diagnostic } from '../core/types.js'
import { hashId } from '../core/util.js'

export interface CodeSpan {
  start: number
  end: number
  kind: 'string' | 'comment' | 'template'
}

export interface BracketPos {
  ch: '(' | '[' | '{'
  close: ')' | ']' | '}'
  line: number
  col: number
  offset: number
}

export interface JsAnalysis {
  diagnostics: Diagnostic[]
  spans: CodeSpan[]
  unclosedOpeners: BracketPos[]
  /** 行号 → 该行需要替换的全角字符（col 为精确位置）。 */
  fullwidthByLine: Map<number, { ch: string; replacement: string; col: number }[]>
}

const FULLWIDTH_MAP: Record<string, string> = {
  '，': ',', '。': '.', '；': ';', '：': ':',
  '（': '(', '）': ')', '【': '[', '】': ']',
  '｛': '{', '｝': '}', '“': '"', '”': '"',
  '‘': "'", '’': "'", '＋': '+', '－': '-',
  '＊': '*', '／': '/', '＝': '=', '＜': '<',
  '＞': '>', '｜': '|', '＆': '&', '！': '!',
  '？': '?', '％': '%', '·': '`',
}

const CLOSERS: Record<string, ')' | ']' | '}'> = { '(': ')', '[': ']', '{': '}' }

type Mode =
  | { t: 'code' }
  | { t: 'str'; quote: string; startLine: number; startCol: number; startOffset: number }
  | { t: 'tpl'; startLine: number; startCol: number; startOffset: number }

const REGEX_PREV_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '%', '+', '-', '*', '/'])
const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case',
  'do', 'else', 'yield', 'await', 'throw', 'void', 'as', 'implements', 'package',
])

export function analyzeJs(text: string, file: string): JsAnalysis {
  const diagnostics: Diagnostic[] = []
  const spans: CodeSpan[] = []
  const stack: BracketPos[] = []
  const fullwidthByLine = new Map<number, { ch: string; replacement: string; col: number }[]>()
  const modeStack: Mode[] = [{ t: 'code' }]

  let mode: Mode = modeStack[0]
  let line = 1
  let col = 1
  let i = 0
  const n = text.length
  let lastSigChar = ''
  let lastWord = ''
  let lineStartOffset = 0

  const setMode = (m: Mode) => {
    mode = m
  }
  const push = (m: Mode) => {
    modeStack.push(m)
    setMode(m)
  }
  const pop = (): Mode => {
    modeStack.pop()
    setMode(modeStack[modeStack.length - 1])
    return mode
  }
  const advance = (): void => {
    if (text[i] === '\n') {
      line++
      col = 1
      lineStartOffset = i + 1
    } else {
      col++
    }
    i++
  }

  const fullwidthAt = (ch: string): void => {
    const replacement = FULLWIDTH_MAP[ch]
    if (!replacement) return
    let arr = fullwidthByLine.get(line)
    if (!arr) {
      arr = []
      fullwidthByLine.set(line, arr)
    }
    arr.push({ ch, replacement, col })
  }

  const emit = (
    rule: string,
    message: string,
    atLine: number,
    atCol: number,
    endLine?: number,
  ): void => {
    diagnostics.push({
      id: hashId(['ast', rule, file, String(atLine), String(atCol)]),
      source: 'ast',
      rule,
      kind: 'syntax',
      file,
      line: atLine,
      column: atCol,
      endLine,
      severity: 'error',
      message,
    })
  }

  mainLoop: while (i < n) {
    // ---- 当前模式：模板字符串 ----
    if (mode.t === 'tpl') {
      const start = i
      let closed = false
      while (i < n) {
        const c = text[i]
        if (c === '\\') {
          advance()
          if (i < n) advance()
          continue
        }
        if (c === '`') {
          closed = true
          advance()
          break
        }
        if (c === '$' && text[i + 1] === '{') {
          // 记录到 `${` 为止的模板跨度，然后切回 code 模式
          spans.push({ start: start, end: i, kind: 'template' })
          advance()
          advance()
          push({ t: 'code' })
          continue mainLoop
        }
        if (c === '\n') {
          // 模板允许跨行
        }
        advance()
      }
      if (closed) {
        spans.push({ start, end: i, kind: 'template' })
      } else {
        emit(
          'js/unterminated-template',
          "Unterminated template literal — missing closing '`' (opened here)",
          mode.startLine,
          mode.startCol,
          line,
        )
        spans.push({ start, end: i, kind: 'template' })
      }
      pop()
      lastSigChar = '`'
      continue
    }

    // ---- 当前模式：引号字符串 ----
    if (mode.t === 'str') {
      const start = i
      let closed = false
      while (i < n) {
        const c = text[i]
        if (c === '\\') {
          advance()
          if (i < n) advance()
          continue
        }
        if (c === mode.quote) {
          closed = true
          advance()
          break
        }
        if (c === '\n') {
          // 单/双引号字符串不允许跨行
          break
        }
        advance()
      }
      if (closed) {
        spans.push({ start, end: i, kind: 'string' })
        lastSigChar = mode.quote
      } else {
        emit(
          'js/unterminated-string',
          `Unterminated string literal — missing closing '${mode.quote}' (opened here)`,
          mode.startLine,
          mode.startCol,
          line,
        )
        spans.push({ start, end: i, kind: 'string' })
      }
      pop()
      continue
    }

    // ---- code 模式：主分派 ----
    const c = text[i]
    const next = i + 1 < n ? text[i + 1] : ''

    if (c === '\n' || c === '\r' || c === ' ' || c === '\t') {
      advance()
      continue
    }

    // shebang
    if (c === '#' && i === 0) {
      while (i < n && text[i] !== '\n') advance()
      continue
    }

    // 行注释
    if (c === '/' && next === '/') {
      const start = i
      while (i < n && text[i] !== '\n') advance()
      spans.push({ start, end: i, kind: 'comment' })
      continue
    }

    // 块注释
    if (c === '/' && next === '*') {
      const start = i
      const startLine = line
      const startCol = col
      advance()
      advance()
      let closed = false
      while (i < n) {
        if (text[i] === '*' && i + 1 < n && text[i + 1] === '/') {
          advance()
          advance()
          closed = true
          break
        }
        advance()
      }
      spans.push({ start, end: i, kind: 'comment' })
      if (!closed) {
        emit(
          'js/unterminated-block-comment',
          'Unterminated block comment — missing */ (opened here)',
          startLine,
          startCol,
          line,
        )
      }
      continue
    }

    // 字符串
    if (c === '"' || c === "'") {
      push({ t: 'str', quote: c, startLine: line, startCol: col, startOffset: i })
      advance()
      continue
    }
    if (c === '`') {
      push({ t: 'tpl', startLine: line, startCol: col, startOffset: i })
      advance()
      continue
    }

    // 正则字面量 vs 除法：看前一个显著字符/词
    if (c === '/') {
      const looksRegex =
        lastSigChar === '' ||
        REGEX_PREV_CHARS.has(lastSigChar) ||
        (lastWord && REGEX_PREV_WORDS.has(lastWord))
      if (looksRegex) {
        const start = i
        advance() // 跳过开头的 /
        let inClass = false
        let ok = false
        while (i < n) {
          const rc = text[i]
          if (rc === '\\') {
            advance()
            if (i < n) advance()
            continue
          }
          if (rc === '\n') {
            // 正则不能跨行——视为残缺
            break
          }
          if (rc === '[') inClass = true
          else if (rc === ']') inClass = false
          else if (rc === '/' && !inClass) {
            advance()
            // flags
            while (i < n && /[a-z]/.test(text[i]!)) advance()
            ok = true
            break
          }
          advance()
        }
        if (!ok) {
          emit(
            'js/unterminated-regex',
            'Unterminated regular expression — missing closing /',
            line,
            col,
          )
        }
        spans.push({ start, end: i, kind: 'string' })
        lastSigChar = '/'
        lastWord = ''
        continue
      }
      lastSigChar = c
      lastWord = ''
      advance()
      continue
    }

    // 括号
    if (c === '(' || c === '[' || c === '{') {
      stack.push({ ch: c, close: CLOSERS[c]!, line, col, offset: i })
      lastSigChar = c
      lastWord = ''
      advance()
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack[stack.length - 1]
      if (!top) {
        emit('js/unmatched-closer', `Unmatched closing bracket '${c}'`, line, col)
      } else if (top.close !== c) {
        emit(
          'js/mismatched-bracket',
          `Mismatched bracket: '${top.ch}' (opened at line ${top.line}:${top.col}) closed by '${c}'`,
          line,
          col,
        )
        stack.pop()
      } else {
        stack.pop()
      }
      lastSigChar = c
      lastWord = ''
      advance()
      continue
    }

    // 全角标点（仅在 code 模式即字符串/注释外）
    if (FULLWIDTH_MAP[c]) {
      fullwidthAt(c)
      lastSigChar = c
      lastWord = ''
      advance()
      continue
    }

    // 单词积累（用于 return/typeof 等正则前导词判断）
    if (/[A-Za-z_$]/.test(c)) {
      let word = ''
      while (i < n && /[A-Za-z0-9_$]/.test(text[i]!)) {
        word += text[i]
        advance()
      }
      lastSigChar = word[0] ?? ''
      lastWord = word
      continue
    }

    lastSigChar = c
    lastWord = ''
    advance()
  }

  // EOF：栈上剩余的都是未闭合括号（从内到外）
  const unclosedOpeners: BracketPos[] = [...stack]
  for (const opener of unclosedOpeners) {
    emit(
      'js/unclosed-bracket',
      `Unclosed bracket '${opener.ch}' opened here — missing '${opener.close}'`,
      opener.line,
      opener.col,
    )
  }

  // 全角标点：每行聚合成一条诊断
  for (const [ln, items] of [...fullwidthByLine.entries()].sort((a, b) => a[0] - b[0])) {
    const pairs = items.map((x) => `'${x.ch}'→'${x.replacement}'`).join(', ')
    emit(
      'js/fullwidth-char',
      `Full-width punctuation in code (${pairs}) — replace with ASCII`,
      ln,
      items[0]!.col,
    )
  }

  return { diagnostics, spans, unclosedOpeners, fullwidthByLine }
}

export function scanJsSyntax(text: string, file: string): Diagnostic[] {
  return analyzeJs(text, file).diagnostics
}

/** 字符串/注释/模板跨度（规则引擎在此范围外执行替换）。 */
export function jsCodeSpans(text: string): CodeSpan[] {
  return analyzeJs(text, fileStub(text)).spans
}

function fileStub(_text: string): string {
  // jsCodeSpans 不需要文件名，传空串即可；诊断结果不会使用
  return '<spans>'
}
