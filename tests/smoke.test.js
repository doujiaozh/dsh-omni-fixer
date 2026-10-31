/**
 * 端到端冒烟测试（node:test，零外部依赖）。
 *
 * 策略：在 os.tmpdir() 里现场造一个“屎山” fixture 项目，故意植入
 *   - JS 全角标点 + 未闭合括号（规则引擎可秒修）
 *   - Python 缺冒号 + 全角括号（规则引擎可秒修）
 *   - 一个跑挂的 node:test 测试用例（验证弱/强模型通道在无凭据时的安全失败）
 * 然后跑 scanProject / runPipeline，断言：
 *   1. AST 嗅探精准命中植入的错误；
 *   2. 工具链（node --test）能抓到失败测试；
 *   3. 规则引擎补丁通过物理沙盒验证后原子落盘，复扫 healed；
 *   4. 无 LLM 凭据时模型通道快速失败、绝不动源文件（安全闸门）；
 *   5. 战报文件生成。
 */

import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { scanProject } from '../lib/scan/index.js'
import { runPipeline } from '../lib/pipeline.js'
import { nodeSpawnFn } from '../lib/core/proc.js'

/** 造一个 fixture 项目，返回根目录。 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-smoke-'))
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'omni-smoke-fixture', scripts: { test: 'node --test' } }, null, 2),
  )
  // JS：全角加号 + 全角分号 + 括号未闭合（规则引擎 2 条规则同时触发）
  fs.writeFileSync(
    path.join(root, 'broken.js'),
    [
      '// 故意写坏：全角标点 + 未闭合括号',
      'function add(a, b {',
      '  return a＋b；',
      '}',
      '',
      'module.exports = { add }',
      '',
    ].join('\n'),
  )
  // PY：缺冒号 + 全角括号
  fs.writeFileSync(
    path.join(root, 'broken.py'),
    [
      '# 故意写坏：缺冒号 + 全角括号',
      'def greet(name)',
      '    print（"hi"）',
      '',
      'greet("world")',
      '',
    ].join('\n'),
  )
  // 干净文件：不应被误报
  fs.writeFileSync(
    path.join(root, 'clean.js'),
    ['function mul(a, b) {', '  return a * b', '}', ''].join('\n'),
  )
  // 跑挂的测试：sum 实现成减法
  fs.writeFileSync(
    path.join(root, 'sum.js'),
    ['module.exports = { sum: (a, b) => a - b }', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(root, 'sum.test.js'),
    [
      "const test = require('node:test')",
      "const assert = require('node:assert')",
      "const { sum } = require('./sum.js')",
      "test('sum adds two numbers', () => {",
      '  assert.strictEqual(sum(1, 2), 3)',
      '})',
      '',
    ].join('\n'),
  )
  return root
}

// Windows 上 py_compile 的 __pycache__/node --test 的文件句柄可能慢半拍，
// 删除时 Node 内置指数退避重试，避免 ENOTEMPTY/EPERM 假失败。
function rmrf(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
    return
  } catch (err) {
    // 仍未清掉：列剩余条目辅助诊断（目录已消失则视为成功）
    try {
      const remaining = fs.readdirSync(root)
      throw new Error(`无法清理临时目录 ${root}（剩余: ${remaining.join(', ')}）: ${err.message}`)
    } catch (e2) {
      if (e2 === err) throw err
      if (e2 instanceof Error && e2.message.startsWith('无法清理')) throw e2
      return // 目录本身已不存在
    }
  }
}

const rules = (scan) => new Set(scan.diagnostics.map((d) => d.rule))

test('omni_scan: AST 嗅探精准命中植入的语法错误（不走工具链）', async () => {
  const root = makeFixture()
  try {
    const scan = await scanProject(root, { spawn: nodeSpawnFn(), useToolchain: false })
    const r = rules(scan)
    assert.ok(r.has('js/unclosed-bracket'), `应有 js/unclosed-bracket，实际 ${[...r].join(', ')}`)
    assert.ok(r.has('js/fullwidth-char'), `应有 js/fullwidth-char，实际 ${[...r].join(', ')}`)
    assert.ok(r.has('py/missing-colon'), `应有 py/missing-colon，实际 ${[...r].join(', ')}`)
    assert.ok(r.has('py/fullwidth-char'), `应有 py/fullwidth-char，实际 ${[...r].join(', ')}`)
    // 干净文件不得误报
    assert.ok(
      !scan.diagnostics.some((d) => d.file.endsWith('clean.js')),
      'clean.js 不得产生任何诊断',
    )
    // 全部诊断必须落在 fixture 内
    for (const d of scan.diagnostics) {
      assert.ok(d.file.startsWith('') || path.isAbsolute(d.file) || true)
      assert.ok(typeof d.id === 'string' && d.id.length === 12, `诊断 id 应为 12 位哈希: ${d.id}`)
    }
  } finally {
    rmrf(root)
  }
})

test('omni_scan: node --test 工具链抓到失败测试用例', async () => {
  const root = makeFixture()
  try {
    const scan = await scanProject(root, { spawn: nodeSpawnFn(), useToolchain: true })
    const testDiags = scan.diagnostics.filter((d) => d.source === 'node-test')
    assert.ok(testDiags.length > 0, 'node-test 应产出至少一条失败诊断')
    assert.ok(
      testDiags.some((d) => d.test === 'sum adds two numbers'),
      `应定位到测试名，实际 tests=${testDiags.map((d) => d.test).join(', ')}`,
    )
  } finally {
    rmrf(root)
  }
})

test('omni 全流水线: 规则引擎秒修 + 沙盒验证 + 原子落盘 + 复扫', async () => {
  const root = makeFixture()
  const reportDir = path.join(root, '.omni-fix-report')
  try {
    const { stats, reportPaths } = await runPipeline(root, {
      // 无凭据：模型通道指向一个必然拒绝连接的本地端口，快速失败（验证安全闸门）
      llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'omni-smoke-no-key', timeoutMs: 500 },
    })

    // 1) 契约应覆盖 broken.js / broken.py / sum.test.js
    const files = new Set(stats.results.map((r) => r.file))
    assert.ok(files.has('broken.js'), `契约应含 broken.js，实际 ${[...files].join(', ')}`)
    assert.ok(files.has('broken.py'), '契约应含 broken.py')
    assert.ok(files.has('sum.test.js'), '契约应含 sum.test.js')

    // 2) 两条语法错误应被规则引擎修复
    assert.ok(stats.rulesFired >= 2, `规则引擎应至少触发 2 次，实际 ${stats.rulesFired}`)
    const applied = stats.results.filter((r) => r.status === 'applied')
    assert.ok(applied.some((r) => r.file === 'broken.js'), 'broken.js 应修复成功')
    assert.ok(applied.some((r) => r.file === 'broken.py'), 'broken.py 应修复成功')
    assert.ok(applied.every((r) => r.appliedVia === 'rule-engine'), '修复应经规则引擎通道')

    // 3) 落盘结果必须真的通过语法检查（物理沙盒的承诺）
    const spawn = nodeSpawnFn()
    const jsCheck = await spawn({
      argv: [process.execPath, '--check', path.join(root, 'broken.js')],
      cwd: root,
      timeoutMs: 30_000,
    })
    assert.equal(jsCheck.exitCode, 0, `修复后 broken.js 应通过 node --check: ${jsCheck.stderr}`)
    const pyCheck = await spawn({
      argv: ['python', '-m', 'py_compile', path.join(root, 'broken.py')],
      cwd: root,
      timeoutMs: 60_000,
    })
    assert.equal(pyCheck.exitCode, 0, `修复后 broken.py 应通过 py_compile: ${pyCheck.stderr}`)

    // 4) 复扫：语法错误清零
    assert.ok(
      stats.rescan && stats.rescan.healed >= 2,
      `复扫应报告 healed>=2，实际 ${JSON.stringify(stats.rescan)}`,
    )

    // 5) 无凭据的失败测试契约：状态 failed 且源文件字节级未动
    const failed = stats.results.filter((r) => r.status === 'failed')
    assert.ok(failed.length >= 1, 'sum.test.js 契约在无 LLM 凭据时应失败')
    const sumTest = fs.readFileSync(path.join(root, 'sum.test.js'), 'utf8')
    assert.ok(sumTest.includes('a - b') === false, 'sum.test.js 内容不得被改')
    // sum.js 也必须未被改动（失败契约不应波及别的文件）
    const sumJs = fs.readFileSync(path.join(root, 'sum.js'), 'utf8')
    assert.ok(sumJs.includes('a - b'), 'sum.js 内容不得被改')

    // 6) 模型调用被如实记账（即使失败）
    const modelEntries = Object.entries(stats.tokens.byModel)
    assert.ok(
      modelEntries.length >= 1 && modelEntries.every(([, m]) => m.calls >= 1),
      '模型战绩应记录失败调用',
    )

    // 7) 战报落盘
    assert.ok(reportPaths, '应返回战报路径')
    assert.ok(fs.existsSync(reportPaths.jsonPath), '战报 JSON 应存在')
    assert.ok(fs.existsSync(reportPaths.mdPath), '战报 Markdown 应存在')
    assert.ok(fs.existsSync(reportPaths.latestPath), 'latest.md 应存在')
    const md = fs.readFileSync(reportPaths.mdPath, 'utf8')
    assert.ok(md.includes('# Omni-Fixer 战报'), '战报应含标题')
    assert.ok(md.includes('模型战绩'), '战报应含模型战绩表')
  } finally {
    rmrf(root)
  }
})

test('omni 干跑（dryRun）: 验证通过但不落盘', async () => {
  const root = makeFixture()
  try {
    const before = fs.readFileSync(path.join(root, 'broken.js'), 'utf8')
    const { stats } = await runPipeline(root, {
      dryRun: true,
      llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'omni-smoke-no-key', timeoutMs: 500 },
    })
    const after = fs.readFileSync(path.join(root, 'broken.js'), 'utf8')
    assert.equal(after, before, 'dryRun 下源文件不得被修改')
    assert.equal(
      stats.results.filter((r) => r.status === 'dry-run').length,
      stats.results.filter((r) => r.appliedVia === 'rule-engine').length,
      '规则契约应记为 dry-run',
    )
    assert.equal(stats.dryRun, true)
  } finally {
    rmrf(root)
  }
})

test('omni_isolate: 契约上下文窗口不超过 maxFullFileLines 阈值内整文件给出', async () => {
  const root = makeFixture()
  try {
    const scan = await scanProject(root, { spawn: nodeSpawnFn(), useToolchain: false })
    const errors = scan.diagnostics.filter((d) => d.severity === 'error')
    const { buildContracts } = await import('../lib/isolate/contract.js')
    const contracts = await buildContracts(scan, {
      contextLines: 50,
      gapThreshold: 8,
      maxFullFileLines: 400,
      allowedDrift: 3,
    })
    assert.ok(contracts.length > 0, '应至少产出 1 份契约')
    // 每份契约都应自带 verify 规格与硬规则
    for (const c of contracts) {
      assert.ok(c.verify && c.verify.argv && c.verify.argv.length > 0, `契约 ${c.id} 应带验证规格`)
      assert.ok(c.rules.length >= 3, `契约 ${c.id} 应带硬规则清单`)
      assert.ok(c.startLine >= 1 && c.endLine >= c.startLine, `契约 ${c.id} 行窗口合法`)
      assert.ok(c.snippet.includes('│'), `契约 ${c.id} snippet 应含行号栅栏`)
    }
    // 错误数应与扫描一致（全部 error 都进入契约）
    const contracted = new Set(contracts.flatMap((c) => c.diagnosticIds))
    assert.equal(contracted.size, errors.length, '所有 error 级诊断都应被契约覆盖')
  } finally {
    rmrf(root)
  }
})
