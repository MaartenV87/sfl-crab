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

    expect(result.smartDig.adaptiveNext).toBe(true)
    expect(
      result.smartDig.endgameOptimal ||
      result.smartDig.adaptiveDepth >= 2
    ).toBe(true)
    expect(result.smartDig.expectedFoundFraction).toBeGreaterThanOrEqual(0)
    expect(result.smartDig.expectedRemainingTargets).toBeGreaterThanOrEqual(0)
    expect(result.smartDig.expectedDigsToComplete).toBeGreaterThan(0)

    for (let i = 1; i < result.smartDigRanking.length; i++) {
      const prev = result.smartDigRanking[i - 1]
      const next = result.smartDigRanking[i]
      expect(
        (prev.expectedDigsToComplete ?? Infinity)
          <= (next.expectedDigsToComplete ?? Infinity)
      ).toBe(true)
    }
  })


  it('prefers a 50/50 direct target over a pure information probe when it lowers expected digs', () => {
    const tiles = emptyTiles(3)
    // Vase at B1 leaves exactly two HIEROGLYPH placements:
    // - Vases A1/B1, target A2
    // - Vases B1/C1, target B2
    // Digging A1/C1 identifies the layout but can never hit the target, so it
    // takes 2 digs. Digging A2/B2 has a 50% direct hit and needs 1.5 digs on
    // average. the expected-cost policy must choose the direct target strategy.
    tiles[1] = treasureTile('vase')

    const result = solveTreasures(
      tiles,
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
    expect(result.targetLayoutCount).toBe(2)
    expect([3, 4]).toContain(result.smartDig.index)
    expect(result.smartDig.targetHitProbability).toBeCloseTo(0.5)
    expect(result.smartDig.expectedDigsToComplete).toBeCloseTo(1.5)
    expect(result.smartDig.endgameOptimal).toBe(true)
    expect(result.smartDig.lookaheadCapped).toBe(false)
    expect(result.smartDig.endgameStateCount).toBeGreaterThan(0)
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


  it('uses a target-only information model for opening moves when global search is capped', () => {
    const result = solveTreasures(
      emptyTiles(3),
      ['HIEROGLYPH'],
      3,
      {
        includeProbabilities: true,
        probabilityTarget: 'hieroglyph',
        probabilitySolutionCap: 1,
        probabilityNodeCap: 10000,
      },
    )

    expect(result.probabilityMode).toBe('approximate')
    expect(result.smartDig).not.toBeNull()
    expect(result.smartDig.openingMode).toBe(true)
    expect(result.smartDig.targetAware).toBe(true)
    expect(result.smartDig.targetInfoGain).toBeGreaterThan(0)
    expect(result.smartDig.targetHitProbability).toBeGreaterThan(0)
    expect(result.smartDig.adaptiveNext).toBe(true)
    expect(result.smartDig.adaptiveDepth).toBeGreaterThanOrEqual(2)
    expect(result.smartDig.expectedDigsToComplete).toBeGreaterThan(0)
    expect(result.smartDig.probabilityBasis).toBe('unique-target-layouts-reduced')
    expect(result.smartDig.openingTargetLayoutCount).toBeGreaterThan(0)
    expect(result.smartDig.targetFeasibilityChecked).toBeGreaterThanOrEqual(0)
    expect(result.smartDig.targetFeasibilityRejected).toBeGreaterThanOrEqual(0)
    expect(result.smartDig.expectedRemainingTargets).toBeGreaterThanOrEqual(0)
    expect(result.targetProbabilities.size).toBeGreaterThan(0)
  })

  it('does not require an information move to win on a marginal approximate cost estimate', () => {
    const tiles = emptyTiles(3)
    tiles[1] = treasureTile('vase')

    const result = solveTreasures(
      tiles,
      ['HIEROGLYPH'],
      3,
      {
        includeProbabilities: true,
        probabilityTarget: 'hieroglyph',
        probabilitySolutionCap: 1,
        probabilityNodeCap: 10000,
      },
    )

    expect(result.probabilityMode).toBe('approximate')
    expect(result.smartDig.targetHitProbability).toBeGreaterThan(0)
    expect(result.smartDig.expectedDigsToComplete).toBeGreaterThan(0)
    if (result.smartDig.robustFallbackUsed) {
      expect(result.smartDig.robustCostMargin).toBeGreaterThan(0)
      expect(result.smartDig.modelPreferredIndex).not.toBeNull()
      expect(result.smartDig.robustCostAdvantage)
        .toBeLessThan(result.smartDig.robustCostMargin)
    }
  })

  it('uses expected digs in the reduced last-target endgame', () => {
    const tiles = emptyTiles(3)
    tiles[1] = treasureTile('vase')

    const result = solveTreasures(
      tiles,
      ['HIEROGLYPH'],
      3,
      {
        includeProbabilities: true,
        probabilityTarget: 'hieroglyph',
        probabilitySolutionCap: 1,
        probabilityNodeCap: 10000,
      },
    )

    expect(result.probabilityMode).toBe('approximate')
    expect(result.targetLayoutCount).toBe(2)
    expect(result.smartDig.openingMode).toBe(true)
    expect(result.smartDig.probabilityBasis).toBe('unique-target-layouts-reduced')
    expect([3, 4]).toContain(result.smartDig.index)
    expect(result.smartDig.targetHitProbability).toBeCloseTo(0.5)
    expect(result.smartDig.expectedDigsToComplete).toBeCloseTo(1.5)
  })

  it('keeps direct target cells in the candidate set when information probes compete', () => {
    const result = solveTreasures(
      emptyTiles(4),
      ['HIEROGLYPH'],
      4,
      {
        includeProbabilities: true,
        probabilityTarget: 'hieroglyph',
        probabilitySolutionCap: 200,
        probabilityNodeCap: 20000,
      },
    )

    expect(result.probabilityMode).toBe('exact')
    const bestDirect = Math.max(
      ...result.smartDigRanking.map(item => item.targetHitProbability || 0),
    )
    expect(bestDirect).toBeGreaterThan(0)
    expect(result.smartDig.expectedDigsToComplete).toBeGreaterThan(0)
  })


  it('keeps approximate opening target percentages aligned with the opening model', () => {
    const result = solveTreasures(
      emptyTiles(3),
      ['HIEROGLYPH'],
      3,
      {
        includeProbabilities: true,
        probabilityTarget: 'hieroglyph',
        probabilitySolutionCap: 1,
        probabilityNodeCap: 10000,
      },
    )

    const best = result.smartDig
    expect(best?.openingMode).toBe(true)
    expect(result.targetProbabilities.get(best.index)).toBeCloseTo(
      best.targetHitProbability,
    )
  })

})
