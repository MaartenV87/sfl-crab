// usePredictionEngine.js — reactive wrapper around solveTreasures.
//
// Watches tiles / patternKeys / enabled and recomputes guaranteed treasure
// locations in a dedicated Web Worker. requestIdleCallback only schedules the
// worker launch; the expensive solver itself never blocks the browser UI thread
// when Worker support is available.

import { ref, watch, onUnmounted, toRaw } from 'vue'
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
  const isCalculating = ref(false)

  const schedule = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? window.requestIdleCallback.bind(window)
    : (cb => setTimeout(cb, 0))
  const cancel = (typeof window !== 'undefined' && window.cancelIdleCallback)
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout

  let idleId = null
  let worker = null
  let solveId = 0

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

  function snapshotForWorker(value) {
    // Vue refs can contain reactive Proxies, which cannot be posted to a
    // worker. Convert the small grid/pattern payload into plain cloneable data.
    return JSON.parse(JSON.stringify(toRaw(value)))
  }

  function runSolve() {
    isCalculating.value = true
    try {
      const result = solveTreasures(
        tilesRef.value,
        patternKeysRef.value,
        gridSize,
        {
          includeProbabilities: Boolean(probabilityRef?.value),
          probabilityTarget: probabilityTargetRef?.value ?? '',
          performanceProfile: performanceProfileRef?.value ?? 'desktop',
        },
      )
      applyResult(result)
    } finally {
      isCalculating.value = false
    }
  }

  function recompute() {
    if (idleId != null) { cancel(idleId); idleId = null }

    // Cancel any in-flight solve immediately. Otherwise an older worker can
    // finish after a newer grid state (or disabled predictions) and overwrite
    // the UI with stale results.
    solveId += 1
    if (worker) {
      worker.terminate()
      worker = null
    }
    isCalculating.value = false

    if (!enabledRef.value) {
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

      // Heavy prediction work must not run on the browser main thread.
      // Terminating the previous worker also gives us a real cancellation
      // mechanism when a new dig arrives before the previous solve finished.
      if (typeof Worker !== 'undefined') {
        const id = ++solveId
        const activeWorker = new Worker(
          new URL('../workers/predictionSolver.worker.js', import.meta.url),
          { type: 'module' },
        )
        worker = activeWorker
        isCalculating.value = true

        activeWorker.onmessage = event => {
          if (event.data?.id !== id) return
          if (event.data?.error) {
            console.error('Prediction worker failed:', event.data.error)
            if (worker === activeWorker) {
              isCalculating.value = false
              worker = null
            }
            activeWorker.terminate()
            return
          }
          applyResult(event.data.result)
          if (worker === activeWorker) {
            isCalculating.value = false
            worker = null
          }
          activeWorker.terminate()
        }

        activeWorker.onerror = event => {
          console.error('Prediction worker error:', event.message || event)
          if (worker === activeWorker) {
            isCalculating.value = false
            worker = null
          }
          activeWorker.terminate()
        }

        activeWorker.postMessage({
          id,
          tiles: snapshotForWorker(tilesRef.value),
          patternKeys: snapshotForWorker(patternKeysRef.value),
          gridSize,
          options: {
            includeProbabilities: Boolean(probabilityRef?.value),
            probabilityTarget: probabilityTargetRef?.value ?? '',
            performanceProfile: performanceProfileRef?.value ?? 'desktop',
          },
        })
        return
      }

      // Legacy fallback for environments without Worker support.
      runSolve()
    })
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

  onUnmounted(() => {
    if (idleId != null) {
      cancel(idleId)
      idleId = null
    }
    if (worker) {
      worker.terminate()
      worker = null
    }
    isCalculating.value = false
  })

  return { isCalculating, guaranteed, guaranteedSlugs, guaranteedCandidates, guaranteedFormationCounts, remainingCounts, remainingRegions, possibleTreasureCells, probabilities, targetProbabilities, globalSolutionCount, probabilityComplete, probabilityReason, probabilityMode, smartDig, smartDigRanking, targetPlan, targetComplete, targetRequiredCount, targetFoundCount, targetRemainingCount, targetLayoutCount }
}
