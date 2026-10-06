// usePredictionEngine.js — reactive wrapper around solveTreasures.
//
// Watches tiles / patternKeys / enabled and recomputes guaranteed treasure
// locations off the main thread via requestIdleCallback (with a setTimeout
// fallback), so a heavy solve never blocks the UI.

import { ref, watch } from 'vue'
import { solveTreasures } from '@/utils/treasureSolver.js'

export function usePredictionEngine(tilesRef, patternKeysRef, enabledRef, { gridSize = 10, syncRef = null, probabilityRef = null } = {}) {
  const guaranteed = ref(new Set())
  const guaranteedSlugs = ref(new Map())
  const guaranteedCandidates = ref(new Map())
  const guaranteedFormationCounts = ref(new Map())
  const remainingCounts = ref(new Map())
  const remainingRegions = ref(new Map())
  const possibleTreasureCells = ref(new Set())
  const probabilities = ref(new Map())
  const globalSolutionCount = ref(0)
  const probabilityComplete = ref(true)
  const probabilityReason = ref(null)
  const probabilityMode = ref('none')
  const smartDig = ref(null)
  const smartDigRanking = ref([])

  const schedule = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? window.requestIdleCallback.bind(window)
    : (cb => setTimeout(cb, 0))
  const cancel = (typeof window !== 'undefined' && window.cancelIdleCallback)
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout

  let idleId = null

  function runSolve() {
    const result = solveTreasures(
      tilesRef.value,
      patternKeysRef.value,
      gridSize,
      { includeProbabilities: Boolean(probabilityRef?.value) },
    )
    guaranteed.value = result.guaranteed
    guaranteedSlugs.value = result.guaranteedSlugs
    guaranteedCandidates.value = result.guaranteedCandidates
    guaranteedFormationCounts.value = result.guaranteedFormationCounts
    remainingCounts.value = result.remainingCounts
    remainingRegions.value = result.remainingRegions
    possibleTreasureCells.value = result.possibleTreasureCells
    probabilities.value = result.probabilities ?? new Map()
    globalSolutionCount.value = result.globalSolutionCount ?? 0
    probabilityComplete.value = result.probabilityComplete ?? true
    probabilityReason.value = result.probabilityReason ?? null
    probabilityMode.value = result.probabilityMode ?? 'none'
    smartDig.value = result.smartDig ?? null
    smartDigRanking.value = result.smartDigRanking ?? []
  }

  function recompute() {
    if (idleId != null) { cancel(idleId); idleId = null }

    if (!enabledRef.value) {
      guaranteed.value = new Set()
      guaranteedSlugs.value = new Map()
      guaranteedCandidates.value = new Map()
      guaranteedFormationCounts.value = new Map()
      remainingCounts.value = new Map()
      remainingRegions.value = new Map()
      possibleTreasureCells.value = new Set()
      probabilities.value = new Map()
      globalSolutionCount.value = 0
      probabilityComplete.value = true
      probabilityReason.value = null
      probabilityMode.value = 'none'
      smartDig.value = null
      smartDigRanking.value = []
      return
    }

    // Synchronous solve during GIF export so every captured frame — including
    // the last — already has its predictions (no requestIdleCallback lag).
    if (syncRef?.value) {
      runSolve()
      return
    }

    idleId = schedule(() => {
      idleId = null
      runSolve()
    })
  }

  const sources = [tilesRef, patternKeysRef, enabledRef]
  if (syncRef) sources.push(syncRef)
  if (probabilityRef) sources.push(probabilityRef)

  watch(
    sources,
    recompute,
    { immediate: true, deep: true }
  )

  return { guaranteed, guaranteedSlugs, guaranteedCandidates, guaranteedFormationCounts, remainingCounts, remainingRegions, possibleTreasureCells, probabilities, globalSolutionCount, probabilityComplete, probabilityReason, probabilityMode, smartDig, smartDigRanking }
}
