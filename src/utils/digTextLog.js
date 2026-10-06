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

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_')
}

function indexLabel(index, gridSize = 10) {
  return `${String.fromCharCode(65 + (index % gridSize))}${Math.floor(index / gridSize) + 1}`
}

function resultForTile(tile) {
  const entries = itemEntries(tile?.items)
  if (!entries.length) return { text: 'Unknown', slugs: [] }
  return {
    text: formatItems(tile.items),
    slugs: entries.map(([name]) => slugify(name)),
  }
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
  predictionJournal = [],
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

  const moveByCell = new Map()
  for (const step of timeline) {
    for (const tile of step.tiles) {
      const idx = Number(tile.y) * gridSize + Number(tile.x)
      moveByCell.set(idx, {
        order: step.order,
        ...resultForTile(tile),
      })
    }
  }

  const journal = (predictionJournal || [])
    .filter(item => item && Number.isFinite(Number(item.afterDigOrder)))
    .sort((a, b) =>
      Number(a.afterDigOrder) - Number(b.afterDigOrder) ||
      String(a.target || '').localeCompare(String(b.target || ''))
    )

  lines.push('', 'PREDICTION_HISTORY:')
  if (!journal.length) {
    lines.push('-')
  } else {
    let testedTop1 = 0
    let hitTop1 = 0
    let testedBest = 0
    let hitBest = 0
    let followedBest = 0

    for (const snap of journal) {
      const after = Number(snap.afterDigOrder) || 0
      const target = slugify(snap.target)
      const nextStep = timeline.find(step => step.order === after + 1)
      const nextIndexes = new Set(
        (nextStep?.tiles || []).map(tile =>
          Number(tile.y) * gridSize + Number(tile.x)
        )
      )

      lines.push(
        `AFTER_DIG: ${after} | TARGET: ${target || '-'} | MODE: ${snap.mode || '-'} | ALGORITHM: ${snap.algorithm || '-'} | SOLUTIONS: ${Number(snap.globalSolutionCount) || 0} | TARGET_LAYOUTS: ${Number(snap.targetLayoutCount) || 0}`,
      )

      if (snap.targetComplete) {
        lines.push(
          `  TARGET_COMPLETE: YES | FOUND: ${Number(snap.targetFoundCount) || 0}/${Number(snap.targetRequiredCount) || 0}`,
        )
      }

      const top = Array.isArray(snap.topCandidates) ? snap.topCandidates : []
      if (top.length) {
        lines.push(
          '  TOP10: ' + top.map((item, i) =>
            `#${i + 1} ${indexLabel(Number(item.index), gridSize)}=${Math.round((Number(item.probability) || 0) * 100)}%`
          ).join(' | ')
        )

        const first = top[0]
        const observed = moveByCell.get(Number(first.index))
        let verdict = 'PENDING'
        if (observed && observed.order > after) {
          testedTop1 += 1
          const hit = observed.slugs.includes(target)
          if (hit) hitTop1 += 1
          verdict = hit ? 'HIT' : 'MISS'
        }
        lines.push(
          `  TOP1_RESULT: ${indexLabel(Number(first.index), gridSize)} | PREDICTED=${Math.round((Number(first.probability) || 0) * 100)}% | FOLLOWED_NEXT=${nextIndexes.has(Number(first.index)) ? 'YES' : 'NO'} | VERDICT=${verdict}${observed && observed.order > after ? ` | DUG_AT=#${observed.order} | ACTUAL=${observed.text}` : ''}`,
        )
      }

      if (snap.best && Number.isFinite(Number(snap.best.index))) {
        const idx = Number(snap.best.index)
        const observed = moveByCell.get(idx)
        const followed = nextIndexes.has(idx)
        if (followed) followedBest += 1
        let verdict = 'PENDING'
        if (observed && observed.order > after) {
          testedBest += 1
          const hit = observed.slugs.includes(target)
          if (hit) hitBest += 1
          verdict = hit ? 'TARGET_HIT' : 'NO_TARGET'
        }

        const info = snap.best.targetAware
          ? `TARGET_INFO_GAIN=${Math.round((Number(snap.best.targetInfoGain) || 0) * 100)}% | TARGET_HIT_P=${Math.round((Number(snap.best.targetHitProbability) || 0) * 100)}%`
          : `EXPECTED_ELIMINATION=${Math.round((Number(snap.best.expectedElimination) || 0) * 100)}%`

        lines.push(
          `  BEST: ${indexLabel(idx, gridSize)} | ${info} | FOLLOWED_NEXT=${followed ? 'YES' : 'NO'} | VERDICT=${verdict}${observed && observed.order > after ? ` | DUG_AT=#${observed.order} | ACTUAL=${observed.text}` : ''}`,
        )
      }

      if (snap.plan?.steps?.length) {
        lines.push(
          '  PLAN: ' + snap.plan.steps.map(step =>
            `P${step.step} ${indexLabel(Number(step.index), gridSize)} direct=${Math.round((Number(step.directProbability) || 0) * 100)}% cumulative=${Math.round((Number(step.cumulativeProbability) || 0) * 100)}%`
          ).join(' | ')
        )
      }
    }

    lines.push(
      `PREDICTION_SUMMARY: TOP1_TESTED=${testedTop1} TOP1_HITS=${hitTop1} BEST_TESTED=${testedBest} BEST_TARGET_HITS=${hitBest} BEST_FOLLOWED_NEXT=${followedBest}`,
    )
  }

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
