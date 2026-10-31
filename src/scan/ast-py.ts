/**
 * omni_scan —— Python 零依赖词法扫描器。
 *
 * 实现一个"行 + 括号深度 + 三引号状态"的 Mini-Python 词法器：
 *   - 缩进栈（unexpected indent / unindent no-match / expected indented block）
 *   - 复合语句缺冒号（if/elif/else/for/while/def/class/with/try/except/finally）
 *   - 括号失衡、未闭合字符串/三引号、全角标点
 *   - tabs/spaces 混用
 *
 * 权威兜底由 python -m py_compile / pytest 承担（工具链扫描器）。
 */
import type { Diagnostic } from '../core/types.js'
import { hashId, splitLines } from '../core/util.js'
import type { CodeSpan, BracketPos } from './ast-js.js'

export interface PyAnalysis {
  diagnostics: Diagnostic[]
  spans: CodeSpan[]
  unclosedOpeners: BracketPos[]
  fullwidthByLine: Map<number, { ch: string; replacement: string; col: number }[]>
}

const FULLWIDTH_MAP: Record<string, string> = {
  '，': ',', '。': '.', '；': ';', '：': ':',
  '（': '(', '）': ')', '【': '[', '】': ']',
  '｛': '{', '｝': '}', '“': '"', '”': '"',
  '‘': "'", '’': "'", '＋': '+', '－': '-',
  '＊': '*', '／': '/', '＝': '=', '＜': '<',
  '＞': '>', '｜': '|', '＆': '&', '！': '!',
  '？': '?', '％': '%',
}

const COMPOUND_WORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'with', 'try', 'except', 'finally',
])

const CLOSERS: Record<string, ')' | ']' | '}'> = { '(': ')', '[': ']', '{': '}' }

export function analyzePy(text: string, file: string): PyAnalysis {
  const lines = splitLines(text)
  const diagnostics: Diagnostic[] = []
  const spans: CodeSpan[] = []
  const bracketStack: BracketPos[] = []
  const fullwidthByLine = new Map<number, { ch: string; replacement: string; col: number }[]>()

  let absLineStart = 0
  let indentStack = [0]
  let lastEndedColon = false
  let bracketDepth = 0
  let triple: { quote: string; line: number; col: number } | null = null

  const emit = (
    rule: string,
    message: string,
    atLine: number,
    atCol: number,
  ): void => {
    diagnostics.push({
      id: hashId(['ast', rule, file, String(atLine), String(atCol)]),
      source: 'ast',
      rule,
      kind: 'syntax',
      file,
      line: atLine,
      column: atCol,
      severity: 'error',
      message,
    })
  }

  const recordFullwidth = (lineNo: number, ch: string, col: number): void => {
    const replacement = FULLWIDTH_MAP[ch]
    if (!replacement) return
    let arr = fullwidthByLine.get(lineNo)
    if (!arr) {
      arr = []
      fullwidthByLine.set(lineNo, arr)
    }
    arr.push({ ch, replacement, col })
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? ''
    const lineNo = li + 1

    // ---- 1. 缩进与空行判定 ----
    let x = 0
    let indent = 0
    let sawSpace = false
    let sawTab = false
    while (x < line.length && (line[x] === ' ' || line[x] === '\t')) {
      if (line[x] === ' ') {
        indent++
        sawSpace = true
      } else {
        indent = Math.floor(indent / 8) * 8 + 8
        sawTab = true
      }
      x++
    }
    if (sawSpace && sawTab) {
      emit('py/inconsistent-indent', 'Inconsistent use of tabs and spaces in indentation', lineNo, 1)
    }

    const rest = line.slice(x)
    const isBlankComment = rest.trim() === '' || rest.trimStart().startsWith('#')
    const endsWithBackslash = line.replace(/\s+$/, '').endsWith('\\')
    const startsNewLogicalLine = bracketDepth === 0 && !triple

    if (startsNewLogicalLine && !isBlankComment) {
      const top = indentStack[indentStack.length - 1] ?? 0
      if (indent > top) {
        if (lastEndedColon) {
          indentStack.push(indent)
        } else {
          emit('py/unexpected-indent', 'Unexpected indent', lineNo, 1)
        }
      } else if (indent < top) {
        while (indentStack.length > 1 && (indentStack[indentStack.length - 1] ?? 0) > indent) {
          indentStack.pop()
        }
        if ((indentStack[indentStack.length - 1] ?? 0) !== indent) {
          emit(
            'py/unindent-no-match',
            'Unindent does not match any outer indentation level',
            lineNo,
            1,
          )
        }
        lastEndedColon = false
      } else if (lastEndedColon) {
        emit('py/expected-indented-block', 'Expected an indented block after compound statement', lineNo, 1)
      }
    }

    // ---- 2. 行内扫描 ----
    // codeText：去注释/字符串后的有效代码字符（供冒号检测）
    let codeText = ''
    let depthAtColonCheck = 0
    let lastSigCol = 0
    let j = x
    while (j < line.length) {
      const c = line[j]!

      if (triple) {
        // 三引号字符串内部
        if (c === '\\') {
          j += 2
          continue
        }
        if (line.startsWith(triple.quote, j)) {
          const start = absLineStart + j
          j += 3
          spans.push({ start, end: absLineStart + j, kind: 'string' })
          triple = null
          continue
        }
        j++
        continue
      }

      if (c === '#') {
        const start = absLineStart + j
        while (j < line.length) j++
        spans.push({ start, end: absLineStart + j, kind: 'comment' })
        continue
      }

      if (c === '"' || c === "'") {
        // 字符串前缀（r/b/u/f 组合）
        let k = j
        while (k > 0 && /[rRbBuUfF]/.test(line[k - 1]!)) k--
        const prefix = line.slice(Math.max(x, k), j).toLowerCase()

        if (line.startsWith(c + c + c, j)) {
          triple = { quote: c + c + c, line: lineNo, col: j + 1 }
          j += 3
          continue
        }
        // 单行字符串
        const startCol = j + 1
        let jj = j + 1
        let closed = false
        while (jj < line.length) {
          const d = line[jj]!
          if (d === '\\') {
            jj += 2
            continue
          }
          if (d === c) {
            closed = true
            jj++
            break
          }
          jj++
        }
        if (!closed) {
          emit(
            'py/unterminated-string',
            `Unterminated string literal — missing closing '${c}' (opened here)`,
            lineNo,
            startCol,
          )
          j = line.length
          continue
        }
        spans.push({ start: absLineStart + j, end: absLineStart + jj, kind: 'string' })
        j = jj
        if (prefix === '' || /^(r|b|u|f|rb|br|fr|rf)$/.test(prefix)) {
          codeText += 'S'
          lastSigCol = jj
        }
        continue
      }

      if (c === '(' || c === '[' || c === '{') {
        bracketStack.push({ ch: c as '(' | '[' | '{', close: CLOSERS[c]!, line: lineNo, col: j + 1, offset: absLineStart + j })
        bracketDepth++
        codeText += c
        lastSigCol = j + 1
        j++
        continue
      }
      if (c === ')' || c === ']' || c === '}') {
        const top = bracketStack[bracketStack.length - 1]
        if (!top) {
          emit('py/unmatched-closer', `Unmatched closing bracket '${c}'`, lineNo, j + 1)
        } else if (top.close !== c) {
          emit(
            'py/mismatched-bracket',
            `Mismatched bracket: '${top.ch}' (opened at line ${top.line}:${top.col}) closed by '${c}'`,
            lineNo,
            j + 1,
          )
          bracketStack.pop()
          bracketDepth = Math.max(0, bracketDepth - 1)
        } else {
          bracketStack.pop()
          bracketDepth = Math.max(0, bracketDepth - 1)
        }
        codeText += c
        lastSigCol = j + 1
        j++
        continue
      }
      if (FULLWIDTH_MAP[c]) {
        recordFullwidth(lineNo, c, j + 1)
        codeText += c
        lastSigCol = j + 1
        j++
        continue
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        // 保留空白：codeText 用于 firstWord/结尾冒号判定，去空格会把
        // `def greet(` 粘成 `defgreet(` 导致复合语句词表失配。
        codeText += ' '
        j++
        continue
      }
      codeText += c
      lastSigCol = j + 1
      j++
    }

    // ---- 3. 逻辑行收尾：冒号检测 ----
    const logicalComplete = bracketDepth === 0 && !triple && !isBlankComment
    if (logicalComplete) {
      const firstWord = codeText.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? ''
      // 深度为 0 处是否有冒号；冒号是否是最后一个有效字符
      let depth = 0
      let colonAt: number | null = null
      for (let q = 0; q < codeText.length; q++) {
        const ch = codeText[q]!
        if (ch === '(' || ch === '[' || ch === '{') depth++
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
        else if (ch === ':' && depth === 0) colonAt = q
      }
      lastEndedColon = colonAt !== null && codeText.trimEnd().endsWith(':')

      if (COMPOUND_WORDS.has(firstWord) && colonAt === null) {
        emit(
          'py/missing-colon',
          `Compound statement '${firstWord}' is missing ':' at end of line`,
          lineNo,
          lastSigCol + 1,
        )
        lastEndedColon = false
      }
      if (endsWithBackslash) {
        lastEndedColon = false
        // 显式续行：下一物理行仍属同一逻辑行
      }
    }

    absLineStart += line.length + 1
  }

  // EOF 收尾
  const unclosedOpeners: BracketPos[] = [...bracketStack]
  for (const opener of unclosedOpeners) {
    emit(
      'py/unclosed-bracket',
      `Unclosed bracket '${opener.ch}' opened here — missing '${opener.close}'`,
      opener.line,
      opener.col,
    )
  }
  if (triple) {
    emit(
      'py/unterminated-triple',
      `Unterminated triple-quoted string — missing closing ${triple.quote} (opened here)`,
      triple.line,
      triple.col,
    )
  }
  for (const [ln, items] of [...fullwidthByLine.entries()].sort((a, b) => a[0] - b[0])) {
    const pairs = items.map((x) => `'${x.ch}'→'${x.replacement}'`).join(', ')
    emit(
      'py/fullwidth-char',
      `Full-width punctuation in code (${pairs}) — replace with ASCII`,
      ln,
      items[0]!.col,
    )
  }

  return { diagnostics, spans, unclosedOpeners, fullwidthByLine }
}

export function scanPySyntax(text: string, file: string): Diagnostic[] {
  return analyzePy(text, file).diagnostics
}
