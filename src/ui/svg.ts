// Charts for the surfaces that draw SVG (the desktop and mobile apps). They fill the width they are
// given (`width` only sets the drawing's proportions), and their colors read on a light and a dark
// background alike; the terminal draws the same numbers as text bars instead.
import { tokens, usd } from './format.ts'
import type { StatusCounts, WorkerBar } from './ui.types.ts'

const COLOR = {
  merged: '#2da44e',
  running: '#d97757',
  review: '#d4a72c',
  failed: '#cf222e',
  queued: '#8c959f',
  label: '#8c959f',
} as const

const FONT = 'font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="11"'

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

/** A stacked bar of the run's tasks by state, with a legend under it. */
export function statusBarSvg(counts: StatusCounts, width = 560): string {
  const parts = [
    { key: 'merged', label: 'merged', n: counts.merged },
    { key: 'running', label: 'running', n: counts.running },
    { key: 'review', label: 'review', n: counts.review },
    { key: 'failed', label: 'failed', n: counts.failed },
    { key: 'queued', label: 'queued', n: counts.queued },
  ] as const
  const total = parts.reduce((sum, p) => sum + p.n, 0)
  let x = 0
  const rects = parts
    .filter(p => p.n > 0)
    .map(p => {
      const w = (p.n / Math.max(1, total)) * width
      const rect = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="10" fill="${COLOR[p.key]}"/>`
      x += w
      return rect
    })
  let lx = 0
  const legend = parts.map(p => {
    const text = `${p.n} ${p.label}`
    const item = `<circle cx="${lx + 4}" cy="25" r="4" fill="${COLOR[p.key]}"/><text x="${lx + 12}" y="29" fill="${COLOR.label}" ${FONT}>${escapeXml(text)}</text>`
    lx += 20 + text.length * 6.5
    return item
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${width} 34">`,
    `<clipPath id="r"><rect width="${width}" height="10" rx="5"/></clipPath>`,
    `<g clip-path="url(#r)"><rect width="${width}" height="10" fill="${COLOR.queued}" fill-opacity="0.25"/>${rects.join('')}</g>`,
    legend.join(''),
    '</svg>',
  ].join('')
}

/** One bar per worker, its length the worker's share of the run's cost, labeled with cost and tokens. */
export function workerCostSvg(workers: readonly WorkerBar[], width = 560): string {
  const rowH = 22
  const labelW = 90
  const valueW = 150
  const barW = Math.max(40, width - labelW - valueW)
  const max = Math.max(...workers.map(w => w.costUsd), 0)
  const rows = workers.map((w, i) => {
    const y = i * rowH
    const len = max > 0 ? Math.max(2, (w.costUsd / max) * barW) : 2
    return [
      `<text x="0" y="${y + 14}" fill="${COLOR.label}" ${FONT}>${escapeXml(w.executor)}</text>`,
      `<rect x="${labelW}" y="${y + 5}" width="${barW}" height="10" rx="5" fill="${COLOR.queued}" fill-opacity="0.2"/>`,
      `<rect x="${labelW}" y="${y + 5}" width="${len.toFixed(1)}" height="10" rx="5" fill="${COLOR.running}"/>`,
      `<text x="${labelW + barW + 10}" y="${y + 14}" fill="${COLOR.label}" ${FONT}>${escapeXml(`${usd(w.costUsd)} · ${tokens(w.tokens)} tok`)}</text>`,
    ].join('')
  })
  const height = Math.max(rowH, workers.length * rowH)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${width} ${height}">${rows.join('')}</svg>`
}
