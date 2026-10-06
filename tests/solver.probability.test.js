import { describe, it, expect } from 'vitest'
import { solveTreasures } from '@/utils/treasureSolver.js'

function emptyTiles(size) {
  return Array.from({ length: size * size }, () => [])
}

function treasureTile(slug) {
  return ['treasure actual-treasure', `tileImage:${slug}`]
}

describe('treasure probability enumeration', () => {
  it('is opt-in so Guaranteed mode does not pay the global-search cost', () => {
    const result = solveTreasures(emptyTiles(3), ['HIEROGLYPH'], 3)
    expect(result.globalSolutionCount).toBe(0)
    expect(result.probabilities.size).toBe(0)
    expect(result.probabilityComplete).toBe(true)
  })

  it('enumerates all valid placements exactly on a small board', () => {
    // HIEROGLYPH is a 2x2 footprint:
    // V V
    // H .
    // On a 3x3 empty board there are exactly four translations.
    const result = solveTreasures(
      emptyTiles(3),
      ['HIEROGLYPH'],
      3,
      { includeProbabilities: true, probabilitySolutionCap: 100, probabilityNodeCap: 10000 },
    )

    expect(result.probabilityComplete).toBe(true)
    expect(result.globalSolutionCount).toBe(4)

    // The Hieroglyph (lower-left of the footprint) appears once in each of
    // cells A2, B2, A3, B3 across the four equally-counted valid layouts.
    for (const idx of [3, 4, 6, 7]) {
      expect(result.probabilities.get(idx)?.get('hieroglyph')).toBeCloseTo(0.25)
    }
  })

  it('keeps undug cells of a confirmed formation at 100 percent', () => {
    const tiles = emptyTiles(3)
    // Revealing the unique Hieroglyph plot at A2 pins Vases at A1/B1.
    tiles[3] = treasureTile('hieroglyph')

    const result = solveTreasures(
      tiles,
      ['HIEROGLYPH'],
      3,
      { includeProbabilities: true, probabilitySolutionCap: 100, probabilityNodeCap: 10000 },
    )

    expect(result.probabilityComplete).toBe(true)
    expect(result.globalSolutionCount).toBe(1)
    expect(result.probabilities.get(0)?.get('vase')).toBe(1)
    expect(result.probabilities.get(1)?.get('vase')).toBe(1)
    expect(result.probabilities.get(3)?.get('hieroglyph')).toBe(1)
  })

  it('falls back to explicitly approximate local percentages when the exact search cap is hit', () => {
    const result = solveTreasures(
      emptyTiles(3),
      ['HIEROGLYPH'],
      3,
      { includeProbabilities: true, probabilitySolutionCap: 1, probabilityNodeCap: 10000 },
    )

    expect(result.probabilityComplete).toBe(false)
    expect(result.probabilityReason).toBe('too-complex')
    expect(result.probabilityMode).toBe('approximate')
    expect(result.probabilities.size).toBeGreaterThan(0)
  })

  it('ranks the most informative next dig from exact global outcomes', () => {
    const result = solveTreasures(
      emptyTiles(3),
      ['HIEROGLYPH'],
      3,
      { includeProbabilities: true, probabilitySolutionCap: 100, probabilityNodeCap: 10000 },
    )

    expect(result.probabilityMode).toBe('exact')
    expect(result.smartDig).not.toBeNull()
    expect(result.smartDigRanking.length).toBeGreaterThan(0)
    expect(result.smartDig.expectedElimination).toBeGreaterThan(0)

    // Ranking must be sorted descending by expected elimination.
    for (let i = 1; i < result.smartDigRanking.length; i++) {
      expect(
        result.smartDigRanking[i - 1].expectedElimination
          >= result.smartDigRanking[i].expectedElimination
      ).toBe(true)
    }
  })

  it('can optimize Smart Dig specifically for the selected treasure', () => {
    const result = solveTreasures(
      emptyTiles(3),
      ['HIEROGLYPH'],
      3,
      {
        includeProbabilities: true,
        probabilityTarget: 'hieroglyph',
        probabilitySolutionCap: 100,
        probabilityNodeCap: 10000,
      },
    )

    expect(result.probabilityMode).toBe('exact')
    expect(result.smartDig).not.toBeNull()
    expect(result.smartDig.targetAware).toBe(true)
    expect(result.smartDig.targetInfoGain).toBeGreaterThanOrEqual(0)
    expect(result.smartDig.targetHitProbability).toBeGreaterThanOrEqual(0)

    for (let i = 1; i < result.smartDigRanking.length; i++) {
      const prev = result.smartDigRanking[i - 1]
      const next = result.smartDigRanking[i]
      expect(
        prev.targetInfoGain > next.targetInfoGain ||
        (
          prev.targetInfoGain === next.targetInfoGain &&
          prev.targetHitProbability >= next.targetHitProbability
        )
      ).toBe(true)
    }
  })


  it('builds a monotonic combined three-step target hit plan', () => {
    const result = solveTreasures(
      emptyTiles(3),
      ['HIEROGLYPH'],
      3,
      {
        includeProbabilities: true,
        probabilityTarget: 'hieroglyph',
        probabilitySolutionCap: 100,
        probabilityNodeCap: 10000,
      },
    )

    expect(result.probabilityMode).toBe('exact')
    expect(result.targetPlan).not.toBeNull()
    expect(result.targetPlan.exact).toBe(true)
    expect(result.targetPlan.steps.length).toBeGreaterThan(0)
    expect(result.targetPlan.steps.length).toBeLessThanOrEqual(3)

    for (let i = 1; i < result.targetPlan.steps.length; i++) {
      expect(
        result.targetPlan.steps[i].cumulativeProbability
          >= result.targetPlan.steps[i - 1].cumulativeProbability
      ).toBe(true)
    }

    expect(result.targetPlan.cumulativeProbability).toBe(
      result.targetPlan.steps[result.targetPlan.steps.length - 1].cumulativeProbability
    )
  })

})
