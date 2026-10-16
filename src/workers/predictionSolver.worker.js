import { solveTreasures } from '../utils/treasureSolver.js'

self.onmessage = event => {
  const { id, tiles, patternKeys, gridSize, options } = event.data || {}
  try {
    const result = solveTreasures(
      tiles,
      patternKeys,
      gridSize,
      options,
    )
    self.postMessage({ id, result })
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
