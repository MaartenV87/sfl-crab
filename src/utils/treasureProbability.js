// Helpers for presenting treasure probabilities returned by treasureSolver.js.

export function getTreasureProbability(probabilities, index, slug) {
  return probabilities?.get(index)?.get(slug) ?? 0
}

export function rankTreasureCells(probabilities, slug, gridSize = 10) {
  const ranked = []
  if (!probabilities || !slug) return ranked

  for (const [index, treasures] of probabilities) {
    const probability = treasures.get(slug) ?? 0
    if (probability <= 0) continue
    ranked.push({
      index,
      probability,
      percent: probability * 100,
      column: String.fromCharCode(65 + (index % gridSize)),
      row: Math.floor(index / gridSize) + 1,
    })
  }
  return ranked.sort((a, b) => b.probability - a.probability || a.index - b.index)
}

export function availableTreasureSlugs(probabilities) {
  const slugs = new Set()
  if (!probabilities) return []
  for (const treasures of probabilities.values()) {
    for (const slug of treasures.keys()) slugs.add(slug)
  }
  return [...slugs].sort()
}

export function treasureDisplayName(slug) {
  return String(slug || '')
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
