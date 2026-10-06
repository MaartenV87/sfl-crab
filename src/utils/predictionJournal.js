import { getTodayUTC } from '@/utils/buildDigTimeline.js'

export const PREDICTION_JOURNAL_VERSION = 1
export const PREDICTION_ALGORITHM_VERSION = 'target-aware-plan3-v1'

function storageKey(landId, utcDate) {
  return `predictionJournal_${String(landId || '0')}_${utcDate || getTodayUTC()}`
}

function canUseStorage() {
  return typeof window !== 'undefined' && !!window.localStorage
}

export function loadPredictionJournal(landId, utcDate = getTodayUTC()) {
  if (!canUseStorage()) return []
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey(landId, utcDate)) || '[]'
    )
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function clearPredictionJournal(landId, utcDate = getTodayUTC()) {
  if (!canUseStorage()) return
  window.localStorage.removeItem(storageKey(landId, utcDate))
}

function normalizeCandidate(candidate) {
  if (!candidate) return null
  return {
    index: Number(candidate.index),
    probability: Number(candidate.probability) || 0,
  }
}

function normalizeBest(best) {
  if (!best) return null
  return {
    index: Number(best.index),
    targetAware: Boolean(best.targetAware),
    targetInfoGain: Number(best.targetInfoGain) || 0,
    targetHitProbability: Number(best.targetHitProbability) || 0,
    worstCaseTargetGain: Number(best.worstCaseTargetGain) || 0,
    expectedElimination: Number(best.expectedElimination) || 0,
    worstCaseElimination: Number(best.worstCaseElimination) || 0,
  }
}

function normalizePlan(plan) {
  if (!plan?.steps?.length) return null
  return {
    exact: Boolean(plan.exact),
    horizon: Number(plan.horizon) || plan.steps.length,
    cumulativeProbability: Number(plan.cumulativeProbability) || 0,
    steps: plan.steps.map(step => ({
      step: Number(step.step),
      index: Number(step.index),
      directProbability: Number(step.directProbability) || 0,
      marginalProbability: Number(step.marginalProbability) || 0,
      cumulativeProbability: Number(step.cumulativeProbability) || 0,
    })),
  }
}

/**
 * Persist one recommendation snapshot for a board state. Re-running the solver
 * for the same dig count + target replaces that snapshot instead of creating
 * duplicates, so the daily log stays compact.
 */
export function recordPredictionSnapshot({
  landId,
  utcDate = getTodayUTC(),
  afterDigOrder = 0,
  target = '',
  mode = 'none',
  globalSolutionCount = 0,
  targetLayoutCount = 0,
  targetComplete = false,
  targetRequiredCount = 0,
  targetFoundCount = 0,
  topCandidates = [],
  best = null,
  plan = null,
} = {}) {
  if (!canUseStorage() || !landId || !target || mode === 'none') return

  const snapshot = {
    v: PREDICTION_JOURNAL_VERSION,
    algorithm: PREDICTION_ALGORITHM_VERSION,
    recordedAt: new Date().toISOString(),
    afterDigOrder: Number(afterDigOrder) || 0,
    target: String(target),
    mode: String(mode),
    globalSolutionCount: Number(globalSolutionCount) || 0,
    targetLayoutCount: Number(targetLayoutCount) || 0,
    targetComplete: Boolean(targetComplete),
    targetRequiredCount: Number(targetRequiredCount) || 0,
    targetFoundCount: Number(targetFoundCount) || 0,
    topCandidates: (topCandidates || [])
      .slice(0, 10)
      .map(normalizeCandidate)
      .filter(Boolean),
    best: normalizeBest(best),
    plan: normalizePlan(plan),
  }

  const list = loadPredictionJournal(landId, utcDate)
  const key = `${snapshot.afterDigOrder}|${snapshot.target}`
  const idx = list.findIndex(item =>
    `${Number(item.afterDigOrder) || 0}|${String(item.target || '')}` === key
  )

  if (idx >= 0) list[idx] = snapshot
  else list.push(snapshot)

  list.sort((a, b) =>
    (Number(a.afterDigOrder) || 0) - (Number(b.afterDigOrder) || 0) ||
    String(a.target).localeCompare(String(b.target))
  )

  try {
    window.localStorage.setItem(storageKey(landId, utcDate), JSON.stringify(list))
  } catch {
    // Ignore quota/private-mode failures; logging must never break digging.
  }
}
