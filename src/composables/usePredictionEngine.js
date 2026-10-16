// usePredictionEngine.js — reactive wrapper around solveTreasures.
//
// Heavy probability solving runs in a dedicated Web Worker during normal app
// usage so mobile and desktop UI remain responsive. Synchronous solving is
// retained only for explicit sync/GIF-export flows.

import { ref, watch, onScopeDispose } from 'vue'
import { solveTreasures } from '@/utils/treasureSolver.js'

export function usePredictionEngine(tilesRef, patternKeysRef, enabledRef, { gridSize = 10, syncRef = null, probabilityRef = null, probabilityTargetRef = null, performanceProfileRef = null } = {}) {
  const guaranteed = ref(new Set())
  const guaranteedSlugs = ref(new Map())
  const guaranteedCandidates = ref(new Map())
  const guaranteedFormationCounts = ref(new Map())
  const remainingCounts = ref(new Map())
  const remainingRegions = ref(new Map())
  const possibleTreasureCells = ref(new Set())
  const probabilities = ref(new Map())
  const targetProbabilities = ref(new Map())
  const globalSolutionCount = ref(0)
  const probabilityComplete = ref(true)
  const probabilityReason = ref(null)
  const probabilityMode = ref('none')
  const smartDig = ref(null)
  const smartDigRanking = ref([])
  const targetPlan = ref(null)
  const targetComplete = ref(false)
  const targetRequiredCount = ref(0)
  const targetFoundCount = ref(0)
  const targetRemainingCount = ref(0)
  const targetLayoutCount = ref(0)
  const isSolving = ref(false)

  let worker = null
  let requestId = 0

  const currentOptions = () => ({
    includeProbabilities: Boolean(probabilityRef?.value),
    probabilityTarget: probabilityTargetRef?.value ?? '',
    performanceProfile: performanceProfileRef?.value ?? 'desktop',
  })

  function applyResult(result) {
    guaranteed.value = result.guaranteed
    guaranteedSlugs.value = result.guaranteedSlugs
    guaranteedCandidates.value = result.guaranteedCandidates
    guaranteedFormationCounts.value = result.guaranteedFormationCounts
    remainingCounts.value = result.remainingCounts
    remainingRegions.value = result.remainingRegions
    possibleTreasureCells.value = result.possibleTreasureCells
    probabilities.value = result.probabilities ?? new Map()
    targetProbabilities.value = result.targetProbabilities ?? new Map()
    globalSolutionCount.value = result.globalSolutionCount ?? 0
    probabilityComplete.value = result.probabilityComplete ?? true
    probabilityReason.value = result.probabilityReason ?? null
    probabilityMode.value = result.probabilityMode ?? 'none'
    smartDig.value = result.smartDig ?? null
    smartDigRanking.value = result.smartDigRanking ?? []
    targetPlan.value = result.targetPlan ?? null
    targetComplete.value = result.targetComplete ?? false
    targetRequiredCount.value = result.targetRequiredCount ?? 0
    targetFoundCount.value = result.targetFoundCount ?? 0
    targetRemainingCount.value = result.targetRemainingCount ?? 0
    targetLayoutCount.value = result.targetLayoutCount ?? 0
  }

  function clearResult() {
    guaranteed.value = new Set()
    guaranteedSlugs.value = new Map()
    guaranteedCandidates.value = new Map()
    guaranteedFormationCounts.value = new Map()
    remainingCounts.value = new Map()
    remainingRegions.value = new Map()
    possibleTreasureCells.value = new Set()
    probabilities.value = new Map()
    targetProbabilities.value = new Map()
    globalSolutionCount.value = 0
    probabilityComplete.value = true
    probabilityReason.value = null
    probabilityMode.value = 'none'
    smartDig.value = null
    smartDigRanking.value = []
    targetPlan.value = null
    targetComplete.value = false
    targetRequiredCount.value = 0
    targetFoundCount.value = 0
    targetRemainingCount.value = 0
    targetLayoutCount.value = 0
  }

  function stopWorker() {
    if (worker) {
      worker.terminate()
      worker = null
    }
  }

  function runSolveSync() {
    stopWorker()
    requestId += 1
    isSolving.value = true
    applyResult(
      solveTreasures(
        tilesRef.value,
        patternKeysRef.value,
        gridSize,
        currentOptions(),
      ),
    )
    isSolving.value = false
  }

  function runSolveWorker() {
    stopWorker()
    const thisRequest = ++requestId
    isSolving.value = true

    try {
      worker = new Worker(
        new URL('../workers/treasureSolver.worker.js', import.meta.url),
        { type: 'module' },
      )
    } catch (error) {
      console.warn('Prediction Web Worker unavailable; using synchronous fallback.', error)
      isSolving.value = false
      console.error('Prediction Web Worker unavailable.', error)
      return
    }

    worker.onmessage = event => {
      if (thisRequest !== requestId) return
      const payload = event.data || {}
      if (!payload.ok) {
        console.error('Prediction worker failed:', payload.error || 'unknown error')
        isSolving.value = false
        stopWorker()
        return
      }
      applyResult(payload.result)
      isSolving.value = false
      stopWorker()
    }

    worker.onerror = event => {
      if (thisRequest !== requestId) return
      console.error('Prediction worker crashed:', event.message || event)
      isSolving.value = false
      stopWorker()
    }

    // Clone only plain reactive values into the worker. Arrays of tile class
    // strings and pattern keys are structured-clone safe.
    worker.postMessage({
      requestId: thisRequest,
      tiles: Array.isArray(tilesRef.value)
        ? tilesRef.value.map(tile => Array.isArray(tile) ? [...tile] : tile)
        : [],
      patternKeys: Array.isArray(patternKeysRef.value)
        ? [...patternKeysRef.value]
        : [],
      gridSize,
      options: currentOptions(),
    })
  }

  function recompute() {
    // Terminating the old worker genuinely aborts expensive solver work when a
    // newer grid state arrives. requestIdleCallback could not do this because
    // solveTreasures still ran on the UI thread once started.
    stopWorker()
    requestId += 1

    if (!enabledRef.value) {
      isSolving.value = false
      clearResult()
      return
    }

    // GIF/export flows explicitly require the result before capture.
    if (syncRef?.value) {
      runSolveSync()
      return
    }

    runSolveWorker()
  }

  const sources = [tilesRef, patternKeysRef, enabledRef]
  if (syncRef) sources.push(syncRef)
  if (probabilityRef) sources.push(probabilityRef)
  if (probabilityTargetRef) sources.push(probabilityTargetRef)
  if (performanceProfileRef) sources.push(performanceProfileRef)

  watch(
    sources,
    recompute,
    { immediate: true, deep: true }
  )

  onScopeDispose(() => {
    stopWorker()
    requestId += 1
    isSolving.value = false
  })

  return { guaranteed, guaranteedSlugs, guaranteedCandidates, guaranteedFormationCounts, remainingCounts, remainingRegions, possibleTreasureCells, probabilities, targetProbabilities, globalSolutionCount, probabilityComplete, probabilityReason, probabilityMode, smartDig, smartDigRanking, targetPlan, targetComplete, targetRequiredCount, targetFoundCount, targetRemainingCount, targetLayoutCount, isSolving }
}
