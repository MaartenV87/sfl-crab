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

  // Outcome KPIs focus on the real objective: how many digs were needed to
  // finish the selected target, especially the expensive last-target phase.
  const selectedTargetSlug = slugify(selectedTarget)
  let selectedTargetRequired = 0
  if (selectedTargetSlug) {
    for (const key of patternKeys || []) {
      for (const plot of DIGGING_FORMATIONS[key] || []) {
        if (slugify(plot.name) === selectedTargetSlug) {
          selectedTargetRequired += 1
        }
      }
    }
  }

  const selectedTargetHits = []
  if (selectedTargetSlug) {
    for (const step of timeline) {
      for (const tile of step.tiles || []) {
        const result = resultForTile(tile)
        if (result.slugs.includes(selectedTargetSlug)) {
          selectedTargetHits.push(step.order)
        }
      }
    }
  }

  if (selectedTargetSlug && selectedTargetRequired > 0) {
    const first = selectedTargetHits[0] ?? null
    const second = selectedTargetHits[1] ?? null
    const completion = selectedTargetHits.length >= selectedTargetRequired
      ? selectedTargetHits[selectedTargetRequired - 1]
      : null
    const nonTargetToComplete = completion == null
      ? null
      : timeline.filter(step => {
          if (step.order > completion) return false
          return !(step.tiles || []).some(tile =>
            resultForTile(tile).slugs.includes(selectedTargetSlug)
          )
        }).length

    lines.push(
      '',
      `TARGET_SEARCH_KPI: REQUIRED=${selectedTargetRequired} | FOUND=${Math.min(selectedTargetHits.length, selectedTargetRequired)} | DIGS_TO_FIRST=${first ?? '-'} | FIRST_TO_SECOND=${first != null && second != null ? second - first : '-'} | SECOND_TO_LAST=${second != null && completion != null ? completion - second : '-'} | COMPLETE_AT=${completion ?? '-'} | NON_TARGET_DIGS_TO_COMPLETE=${nonTargetToComplete ?? '-'}`,
    )
  }

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
    let testedNext = 0
    let hitNext = 0
    let followedNext = 0

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
        if (followed) followedNext += 1
        let verdict = 'PENDING'
        if (observed && observed.order > after) {
          testedNext += 1
          const hit = observed.slugs.includes(target)
          if (hit) hitNext += 1
          verdict = hit ? 'TARGET_HIT' : 'NO_TARGET'
        }

        const hasExpectedDigs =
          snap.best.expectedDigsToComplete != null &&
          Number.isFinite(Number(snap.best.expectedDigsToComplete))
        const expectedDigsText = hasExpectedDigs
          ? Number(snap.best.expectedDigsToComplete).toFixed(2)
          : '-'
        const info = snap.best.targetAware
          ? snap.best.openingMode
            ? `OPENING=YES | TARGET_INFO_SPLIT=${Math.round((Number(snap.best.targetInfoGain) || 0) * 100)}% | TARGET_HIT_P=${Math.round((Number(snap.best.targetHitProbability) || 0) * 100)}% | CONFIG_HIT_P=${Math.round((Number(snap.best.configurationTargetHitProbability) || 0) * 100)}% | EXPECTED_DIGS_LEFT=${expectedDigsText} | DEPTH=${Number(snap.best.adaptiveDepth) || 0} | TARGET_LAYOUTS=${Number(snap.best.openingTargetLayoutCount) || 0} | TARGET_CONFIGS=${Number(snap.best.openingConfigurationCount) || 0} | FEAS_CHECKED=${Number(snap.best.targetFeasibilityChecked) || 0} | FEAS_REJECTED=${Number(snap.best.targetFeasibilityRejected) || 0} | FEAS_CAPPED=${snap.best.targetFeasibilityCapped ? 'YES' : 'NO'} | CAPPED=${snap.best.lookaheadCapped ? 'YES' : 'NO'}`
            : `TARGET_INFO_GAIN=${Math.round((Number(snap.best.targetInfoGain) || 0) * 100)}% | TARGET_HIT_P=${Math.round((Number(snap.best.targetHitProbability) || 0) * 100)}% | DEPTH=${snap.best.endgameOptimal ? 'OPTIMAL' : (Number(snap.best.adaptiveDepth) || 0)} | EXPECTED_DIGS_LEFT=${expectedDigsText} | EXPECTED_LEFT=${Number(snap.best.expectedRemainingTargets) || 0} | ENDGAME_OPTIMAL=${snap.best.endgameOptimal ? 'YES' : 'NO'} | ENDGAME_STATES=${Number(snap.best.endgameStateCount) || 0} | CAPPED=${snap.best.lookaheadCapped ? 'YES' : 'NO'}`
          : `EXPECTED_ELIMINATION=${Math.round((Number(snap.best.expectedElimination) || 0) * 100)}%`

        const robustInfo = snap.best.robustFallbackUsed
          ? ` | ROBUST_FALLBACK=YES | ROBUST_REASON=${snap.best.robustReason || '-'} | MODEL_ADVANTAGE=${Number(snap.best.robustCostAdvantage || 0).toFixed(2)} | REQUIRED_MARGIN=${Number(snap.best.robustCostMargin || 0).toFixed(2)}`
          : ''
        lines.push(
          `  NEXT: ${indexLabel(idx, gridSize)} | ${info}${robustInfo} | FOLLOWED_NEXT=${followed ? 'YES' : 'NO'} | VERDICT=${verdict}${observed && observed.order > after ? ` | DUG_AT=#${observed.order} | ACTUAL=${observed.text}` : ''}`,
        )

        if (
          snap.best.robustFallbackUsed &&
          snap.best.modelPreferredIndex != null &&
          Number.isFinite(Number(snap.best.modelPreferredIndex))
        ) {
          const modelCost =
            snap.best.modelPreferredExpectedDigs != null &&
            Number.isFinite(Number(snap.best.modelPreferredExpectedDigs))
              ? Number(snap.best.modelPreferredExpectedDigs).toFixed(2)
              : '-'
          lines.push(
            `  MODEL_PICK: ${indexLabel(Number(snap.best.modelPreferredIndex), gridSize)} | TARGET_HIT_P=${Math.round((Number(snap.best.modelPreferredProbability) || 0) * 100)}% | EXPECTED_DIGS_LEFT=${modelCost}`,
          )
        }

        if (
          snap.best.bestDirectAlternativeIndex != null &&
          Number.isFinite(Number(snap.best.bestDirectAlternativeIndex)) &&
          Number(snap.best.bestDirectAlternativeIndex) !== idx
        ) {
          const directCost =
            snap.best.bestDirectAlternativeExpectedDigs != null &&
            Number.isFinite(Number(snap.best.bestDirectAlternativeExpectedDigs))
              ? Number(snap.best.bestDirectAlternativeExpectedDigs).toFixed(2)
              : '-'
          lines.push(
            `  DIRECT_ALT: ${indexLabel(Number(snap.best.bestDirectAlternativeIndex), gridSize)} | TARGET_HIT_P=${Math.round((Number(snap.best.bestDirectAlternativeProbability) || 0) * 100)}% | EXPECTED_DIGS_LEFT=${directCost}`,
          )
        }
      }

      if (snap.plan?.steps?.length) {
        lines.push(
          '  PLAN: ' + snap.plan.steps.map(step =>
            `P${step.step} ${indexLabel(Number(step.index), gridSize)} direct=${Math.round((Number(step.directProbability) || 0) * 100)}% cumulative=${Math.round((Number(step.cumulativeProbability) || 0) * 100)}%`
          ).join(' | ')
        )
      }
    }

    // Compare predicted expected cost with the eventual observed completion
    // only for stretches where NEXT was followed at every subsequent dig.
    if (selectedTargetSlug && selectedTargetRequired > 0) {
      const completionOrder = selectedTargetHits.length >= selectedTargetRequired
        ? selectedTargetHits[selectedTargetRequired - 1]
        : null
      if (completionOrder != null) {
        const sameTargetJournal = journal.filter(snap =>
          slugify(snap.target) === selectedTargetSlug
        )
        let calibrationCount = 0
        let calibrationAbsError = 0

        for (const snap of sameTargetJournal) {
          const after = Number(snap.afterDigOrder) || 0
          if (
            snap.best?.expectedDigsToComplete == null ||
            after >= completionOrder
          ) continue
          const expected = Number(snap.best.expectedDigsToComplete)
          if (!Number.isFinite(expected)) continue

          let followedAll = true
          for (let order = after + 1; order <= completionOrder; order++) {
            const state = sameTargetJournal.find(item =>
              Number(item.afterDigOrder) === order - 1
            )
            const recommended = Number(state?.best?.index)
            const actualStep = timeline.find(step => step.order === order)
            const actualIndexes = new Set(
              (actualStep?.tiles || []).map(tile =>
                Number(tile.y) * gridSize + Number(tile.x)
              ),
            )
            if (!Number.isFinite(recommended) || !actualIndexes.has(recommended)) {
              followedAll = false
              break
            }
          }

          if (followedAll) {
            calibrationCount += 1
            calibrationAbsError += Math.abs(
              expected - (completionOrder - after),
            )
          }
        }

        if (calibrationCount > 0) {
          lines.push(
            `EXPECTED_COST_CALIBRATION: FOLLOWED_STATES=${calibrationCount} | MAE=${(calibrationAbsError / calibrationCount).toFixed(2)} digs`,
          )
        }
      }
    }

    lines.push(
      `PREDICTION_SUMMARY: TOP1_TESTED=${testedTop1} TOP1_HITS=${hitTop1} NEXT_TESTED=${testedNext} NEXT_TARGET_HITS=${hitNext} NEXT_FOLLOWED=${followedNext}`,
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
