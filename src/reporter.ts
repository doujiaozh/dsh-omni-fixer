/**
 * omni_reporter —— 战报生成。
 *
 * 输出五要素：扫描代码行数、发现错误数、修复成功数、Token 消耗、各模型战绩。
 * 人类可读版写 Markdown（latest.md + <runId>.md），机器可读版写 JSON。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { RunStats } from './core/types.js'
import { fmtDuration } from './core/util.js'

export const REPORT_DIR_NAME = '.omni-fix-report'

export function modelWarRecord(stats: RunStats): Array<{ model: string; prompt: number; completion: number; calls: number; total: number; fixes: number }> {
  const fixesByModel: Record<string, number> = {}
  for (const r of stats.results) {
    if (r.status === 'applied' && r.appliedModel) {
      fixesByModel[r.appliedModel] = (fixesByModel[r.appliedModel] ?? 0) + 1
    }
  }
  return Object.entries(stats.tokens.byModel)
    .map(([model, u]) => ({
      model,
      prompt: u.prompt,
      completion: u.completion,
      calls: u.calls,
      total: u.prompt + u.completion,
      fixes: fixesByModel[model] ?? 0,
    }))
    .sort((a, b) => b.total - a.total)
}

export function renderReport(stats: RunStats): string {
  const lines: string[] = []
  const healed = stats.rescan ? stats.rescan.healed : stats.results.filter((r) => r.status === 'applied').length
  const failed = stats.results.filter((r) => r.status === 'failed').length
  const ruleFixes = stats.results.filter((r) => r.appliedVia === 'rule-engine').length
  const tokenTotal = stats.tokens.prompt + stats.tokens.completion

  lines.push(`# Omni-Fixer 战报 ${stats.runId}`)
  lines.push('')
  lines.push(`- 项目根目录：\`${stats.root}\``)
  lines.push(`- 开始：${stats.startedAt}${stats.finishedAt ? ` · 结束：${stats.finishedAt} · 耗时 ${fmtDuration(stats.durationMs ?? 0)}` : ''}`)
  lines.push(`- 模式：${stats.dryRun ? '**Dry Run**（验证但不落盘）' : '全自动修复'}`)
  lines.push('')
  lines.push('## 概览')
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('|---|---|')
  lines.push(`| 扫描代码行数 | ${stats.scan.linesScanned.toLocaleString()} |`)
  lines.push(`| 扫描文件数 | ${stats.scan.filesScanned.toLocaleString()} |`)
  lines.push(`| 发现错误数 | ${stats.scan.diagnosticsFound} |`)
  lines.push(`| 生成契约数 | ${stats.contracts.total}（trivial ${stats.contracts.byComplexity.trivial ?? 0} / moderate ${stats.contracts.byComplexity.moderate ?? 0} / hard ${stats.contracts.byComplexity.hard ?? 0}）|`)
  lines.push(`| 修复成功数 | ${healed} |`)
  lines.push(`| 修复失败数 | ${failed} |`)
  lines.push(`| 规则引擎秒修 | ${ruleFixes}（零 token）|`)
  lines.push(`| 修复尝试总数 | ${stats.attempts} |`)
  lines.push(`| Token 消耗 | prompt ${stats.tokens.prompt.toLocaleString()} + completion ${stats.tokens.completion.toLocaleString()} = **${tokenTotal.toLocaleString()}** |`)
  lines.push('')

  const records = modelWarRecord(stats)
  if (records.length > 0) {
    lines.push('## 模型战绩')
    lines.push('')
    lines.push('| 模型 | 调用次数 | 修复成功 | Token（输入/输出/合计）|')
    lines.push('|---|---|---|---|')
    for (const r of records) {
      lines.push(`| ${r.model} | ${r.calls} | ${r.fixes} | ${r.prompt.toLocaleString()} / ${r.completion.toLocaleString()} / ${r.total.toLocaleString()} |`)
    }
    lines.push('')
  }

  lines.push('## 契约明细')
  lines.push('')
  for (const r of stats.results) {
    const icon = r.status === 'applied' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'dry-run' ? '🧪' : '⏭'
    lines.push(`### ${icon} \`${r.file}\` — ${r.status}`)
    lines.push('')
    if (r.appliedVia) {
      lines.push(`- 由 **${r.appliedVia}**${r.appliedModel && r.appliedModel !== 'rule-engine' ? `（${r.appliedModel}）` : ''}修复，共 ${r.attempts.length} 轮`)
    }
    if (r.finalError) {
      lines.push(`- 最终错误：${r.finalError}`)
    }
    const attemptLines = r.attempts.map((a) => `- R${a.round} ${a.channel} (${a.model}) → ${a.ok ? '✅ 验证通过' : a.failureReason ?? '失败'}`)
    if (attemptLines.length > 0) lines.push(...attemptLines)
    lines.push('')
  }

  if (stats.rescan) {
    lines.push('## 复扫对比')
    lines.push('')
    lines.push(`- 修复前错误数：${stats.rescan.before}`)
    lines.push(`- 修复后错误数：${stats.rescan.after}`)
    lines.push(`- 治愈：**${stats.rescan.healed}**`)
    if (stats.rescan.remaining.length > 0) {
      lines.push('')
      lines.push('仍存在的错误：')
      for (const d of stats.rescan.remaining.slice(0, 20)) {
        lines.push(`- \`${d.file}:${d.line}\` [${d.source}${d.rule ? ` ${d.rule}` : ''}] ${d.message}`)
      }
    }
    lines.push('')
  }

  if (stats.notes.length > 0) {
    lines.push('## 备注（非致命）')
    lines.push('')
    for (const n of stats.notes) lines.push(`- ${n}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function renderConsoleSummary(stats: RunStats): string {
  const tokenTotal = stats.tokens.prompt + stats.tokens.completion
  return [
    `omni_reporter: 扫描 ${stats.scan.filesScanned} 文件 / ${stats.scan.linesScanned} 行`,
    `发现错误 ${stats.scan.diagnosticsFound} → 契约 ${stats.contracts.total}`,
    `修复成功 ${stats.results.filter((r) => r.status === 'applied').length}`,
    `失败 ${stats.results.filter((r) => r.status === 'failed').length}`,
    `Token ${tokenTotal}`,
  ].join(' | ')
}

export async function writeReport(
  stats: RunStats,
  reportDir: string,
): Promise<{ dir: string; jsonPath: string; mdPath: string; latestPath: string }> {
  await fs.promises.mkdir(reportDir, { recursive: true })
  const jsonPath = path.join(reportDir, `${stats.runId}.json`)
  const mdPath = path.join(reportDir, `${stats.runId}.md`)
  const latestPath = path.join(reportDir, 'latest.md')
  await fs.promises.writeFile(jsonPath, JSON.stringify(stats, null, 2), 'utf8')
  await fs.promises.writeFile(mdPath, renderReport(stats), 'utf8')
  await fs.promises.writeFile(latestPath, renderReport(stats), 'utf8')
  return { dir: reportDir, jsonPath, mdPath, latestPath }
}
