import { buildDigTimeline, getTodayUTC } from '@/utils/buildDigTimeline.js'
import { DIGGING_FORMATIONS } from '@/data/game/diggingFormations.js'
import { buildServerCompletedIndexes } from '@/utils/patternPreview.js'

export const DIG_TEXT_LOG_VERSION = 1

export function cellLabelFromXY(x, y) {
  return `${String.fromCharCode(65 + Number(x))}${Number(y) + 1}`
}

function itemEntries(items) {
  return Object.entries(items || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => [name, Number(count)])
}

function formatItems(items) {
  const entries = itemEntries(items)
  if (!entries.length) return 'Unknown'
  return entries
    .map(([name, count]) => count === 1 ? name : `${name} x${count}`)
    .join(' + ')
}

function flattenRawGrid(rawGrid) {
  if (!Array.isArray(rawGrid)) return []
  return rawGrid.flatMap(entry => Array.isArray(entry) ? entry : [entry])
}

function formationSpec(key) {
  return (DIGGING_FORMATIONS[key] || [])
    .map(plot => `${plot.name}@(${plot.x},${plot.y})`)
    .join('; ')
}

function sortedLocations(map) {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, labels]) => [
      name,
      [...new Set(labels)].sort((a, b) => {
        const rowA = Number(a.slice(1))
        const rowB = Number(b.slice(1))
        return rowA - rowB || a.charCodeAt(0) - b.charCodeAt(0)
      }),
    ])
}

/**
 * Build a compact, stable, copy/paste-friendly log for analysing digging
 * strategy over many days. Everything needed to replay the observed session is
 * included: exact daily formations, ordered digs/results, completed pattern
 * instances and final revealed object locations.
 */
export function buildDigTextLog({
  rawGrid = [],
  patternKeys = [],
  completedPatternKeys = [],
  manualCompletedIndexes = [],
  utcDate = getTodayUTC(),
  landId = '',
  selectedTarget = '',
  gridSize = 10,
} = {}) {
  const timeline = buildDigTimeline(rawGrid)
  const serverCompleted = buildServerCompletedIndexes(
    patternKeys,
    completedPatternKeys,
  )
  const completedIndexes = new Set([
    ...serverCompleted,
    ...(manualCompletedIndexes || []),
  ])

  const lines = [
    `SFL_DIG_TEXT_LOG_V${DIG_TEXT_LOG_VERSION}`,
    `DATE_UTC: ${utcDate || getTodayUTC()}`,
    `LAND: ${landId || '-'}`,
    `GRID: ${gridSize}x${gridSize}`,
    `SELECTED_TARGET: ${selectedTarget || '-'}`,
    `DIG_STEPS: ${timeline.length}`,
    '',
    'PATTERNS:',
  ]

  patternKeys.forEach((key, index) => {
    const status = completedIndexes.has(index) ? 'COMPLETE' : 'OPEN'
    lines.push(
      `${String(index + 1).padStart(2, '0')} | ${status} | ${key} | ${formationSpec(key)}`,
    )
  })
  if (!patternKeys.length) lines.push('-')

  lines.push('', 'MOVES:')
  for (const step of timeline) {
    const cells = step.tiles.map(tile => {
      const label = cellLabelFromXY(tile.x, tile.y)
      const result = formatItems(tile.items)
      const tool = tile.tool ? ` [${tile.tool}]` : ''
      return `${label}=${result}${tool}`
    })
    lines.push(
      `#${String(step.order).padStart(3, '0')} | ${cells.join(' | ')}`,
    )
  }
  if (!timeline.length) lines.push('-')

  // Last observed state for every dug cell. This deliberately records only
  // facts returned by the game, never custom hints or solver predictions.
  const latestByCell = new Map()
  for (const tile of flattenRawGrid(rawGrid)) {
    if (!tile || !Number.isFinite(Number(tile.x)) || !Number.isFinite(Number(tile.y))) continue
    latestByCell.set(`${tile.x},${tile.y}`, tile)
  }

  const locations = new Map()
  for (const tile of latestByCell.values()) {
    const label = cellLabelFromXY(tile.x, tile.y)
    for (const [name] of itemEntries(tile.items)) {
      if (!locations.has(name)) locations.set(name, [])
      locations.get(name).push(label)
    }
  }

  lines.push('', 'FINAL_KNOWN_LOCATIONS:')
  for (const [name, labels] of sortedLocations(locations)) {
    lines.push(`${name}: ${labels.join(', ')}`)
  }
  if (!locations.size) lines.push('-')

  const totalCells = gridSize * gridSize
  lines.push(
    '',
    `REVEALED_CELLS: ${latestByCell.size}/${totalCells}`,
    `UNKNOWN_CELLS: ${Math.max(0, totalCells - latestByCell.size)}`,
    '',
    'END_SFL_DIG_TEXT_LOG',
  )

  return lines.join('\n')
}
