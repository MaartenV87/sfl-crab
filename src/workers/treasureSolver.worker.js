import { solveTreasures } from '@/utils/treasureSolver.js'

self.onmessage = event => {
  const { requestId, tiles, patternKeys, gridSize, options } = event.data || {}
  try {
    const result = solveTreasures(
      tiles,
      patternKeys,
      gridSize,
      options,
    )
    self.postMessage({ requestId, ok: true, result })
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
