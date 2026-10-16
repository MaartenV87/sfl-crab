// treasureSolver.js — sound, treasure-anchored guaranteed-treasure solver.
//
// Mechanics: treasures only appear inside fixed formation shapes, placed by
// translation only (no rotation/reflection). Crabs surround treasures; sand is
// empty. Given the revealed tiles + the multiset of formation shapes on the
// board, we deduce tiles that MUST be treasures.
//
// Algorithm (local, per revealed treasure — always sound, never a false
// positive): a revealed treasure T belongs to exactly one real formation
// placement. Enumerate EVERY legal placement (of any shape) that could cover T
// — i.e. some plot of that shape lands on T with a matching name, and no plot
// lands on revealed sand/crab or on a differently-named revealed treasure. The
// real placement is necessarily one of these candidates, so any tile that is a
// treasure-plot in ALL candidates must be a treasure. Intersecting the
// candidate plot-sets yields guaranteed tiles.
//
// Why local (not a global "place all formations" search): the global search is
// exponential and, once capped, its solution set is incomplete — intersecting
// an incomplete set can mark a tile that an un-enumerated placement leaves
// empty (a wrong guarantee). The local method needs no cap and is instant.
//
// No Vue reactivity here — this is a pure, testable module.

import { DIGGING_FORMATIONS } from '@/data/game/diggingFormations.js'

/**
 * Subtract the completed-pattern multiset from the active-pattern multiset,
 * returning the formation keys still in play (preserving duplicates).
 * Retained as a utility; the solver itself does NOT require completed-pattern
 * removal (see solveTreasures — it anchors on revealed treasures and is sound
 * with the full board multiset).
 *
 * @param {string[]} patternKeys
 * @param {string[]} completedPatternKeys
 * @returns {string[]}
 */
export function computeActivePatternKeys(patternKeys, completedPatternKeys) {
  const remaining = new Map()
  for (const key of completedPatternKeys || []) {
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  return (patternKeys || []).filter(key => {
    const left = remaining.get(key) ?? 0
    if (left > 0) {
      remaining.set(key, left - 1)
      return false // this instance is completed, skip it
    }
    return true // this instance is still in play
  })
}

// Normalize a name for case/underscore/space-insensitive comparison.
function normName(s) {
  return String(s).toLowerCase().replace(/[\s_]+/g, ' ').trim()
}

function namesMatch(a, b) {
  return normName(a) === normName(b)
}

// Treasure slug for the asset path: normalize, then join words with '_'.
// e.g. "Clam Shell" → "clam_shell", "Salt Dino Egg" → "salt_dino_egg".
function slugify(name) {
  return normName(name).replace(/\s+/g, '_')
}

/**
 * Flatten a tile's class entries into individual tokens. A revealed treasure
 * tile is stored as `['treasure actual-treasure', 'tileImage:<slug>']` — the
 * first element is ONE space-joined string, so split on spaces before testing
 * membership.
 *
 * @param {string[]|string} tile
 * @returns {string[]}
 */
function flattenTile(tile) {
  if (!tile) return []
  const arr = Array.isArray(tile) ? tile : [tile]
  return arr.flatMap(c => String(c).split(' '))
}

/**
 * @param {(string[]|string)[]} tiles - grid cells of CSS class arrays
 * @param {string[]} patternKeys - formation multiset on the board
 * @param {number} gridSize - default 10
 * @returns {{ guaranteed: Set<number>, guaranteedSlugs: Map<number,string>, guaranteedCandidates: Map<number,string[]>, guaranteedFormationCounts: Map<string,number>, remainingCounts: Map<string,number>, remainingRegions: Map<string,Set<number>>, possibleTreasureCells: Set<number>, partial: boolean }}
 */
export function solveTreasures(
  tiles,
  patternKeys,
  gridSize = 10,
  {
    includeProbabilities = false,
    probabilityTarget = '',
    probabilitySolutionCap = 20000,
    probabilityNodeCap = 100000,
  } = {},
) {
  const guaranteed = new Set()
  if (!patternKeys?.length) {
    return {
      guaranteed,
      guaranteedSlugs: new Map(),
      guaranteedCandidates: new Map(),
      guaranteedFormationCounts: new Map(),
      remainingCounts: new Map(),
      remainingRegions: new Map(),
      possibleTreasureCells: new Set(),
      probabilities: new Map(),
      targetProbabilities: new Map(),
      globalSolutionCount: 0,
      probabilityComplete: true,
      probabilityReason: null,
      probabilityMode: 'none',
      smartDig: null,
      smartDigRanking: [],
      targetPlan: null,
      targetComplete: false,
      targetRequiredCount: 0,
      targetFoundCount: 0,
      targetRemainingCount: 0,
      targetLayoutCount: 0,
      partial: false,
    }
  }

  // ── Parse revealed state ────────────────────────────────────────────
  const revealedSand = new Set()
  const revealedCrab = new Set()
  const revealedTreasureName = new Map() // idx -> display name

  const cells = tiles || []
  for (let idx = 0; idx < cells.length; idx++) {
    const tokens = flattenTile(cells[idx])
    if (!tokens.length) continue

    if (tokens.includes('treasure') && tokens.includes('actual-treasure')) {
      const imgTok = tokens.find(t => t.startsWith('tileImage:'))
      const slug = imgTok ? imgTok.slice('tileImage:'.length) : ''
      revealedTreasureName.set(idx, slug.replace(/_/g, ' '))
    } else if (tokens.includes('sand')) {
      revealedSand.add(idx)
    } else if (tokens.includes('crab')) {
      revealedCrab.add(idx)
    }
    // else: undug / hint-only — unknown, could be treasure
  }

  // Preserve the cells the player has actually dug. revealedTreasureName is
  // later extended with pseudo-reveals from Guaranteed mode, which must still
  // remain eligible as future digs for the information-gain ranking.
  const actuallyRevealedCells = new Set([
    ...revealedSand,
    ...revealedCrab,
    ...revealedTreasureName.keys(),
  ])
  const actuallyRevealedTreasureName = new Map(revealedTreasureName)

  // Formation shapes present on the board. Dedup by key (one instance is enough
  // for local reasoning), and include every shape so a revealed treasure can be
  // anchored to whichever shape truly owns it.
  const shapes = [...new Set(patternKeys)]
    .filter(key => Array.isArray(DIGGING_FORMATIONS[key]) && DIGGING_FORMATIONS[key].length)
    .map(key => ({ key, formation: DIGGING_FORMATIONS[key] }))

  const inBounds = (x, y) => x >= 0 && x < gridSize && y >= 0 && y < gridSize

  // Build a legal placement of `formation` translated so plot origin sits at
  // (ox, oy). Returns a Map<idx,name> of treasure-plots, or null if impossible.
  //
  // Soundness of the sand-adjacency check: per game mechanics every treasure is
  // orthogonally surrounded by crabs, same-formation treasures, or the board
  // edge — NEVER sand. So if a plot of this placement would land orthogonally
  // adjacent to a revealed sand tile (and that neighbor isn't itself a plot of
  // this same placement), the placement cannot be real. This only ever removes
  // impossible candidates, so it can never drop the real placement.
  //
  // Soundness of the committed-cell exclusion (Layer 1): the real board has
  // exactly ONE item per cell — two formation instances can never share a
  // treasure cell. A cell already proven to belong to a CONFIRMED instance
  // (committedCellOrigin) therefore cannot host a plot of any other instance —
  // including another instance of the SAME shape. Most artefact formations
  // share the names "Camel Bone"/seasonal-artefact, so without this check a
  // same-name overlapping candidate survives and bloats the candidate set,
  // hiding guarantees the intersection would otherwise prove.
  const buildPlacement = (key, formation, ox, oy) => {
    const plots = new Map()
    for (const p of formation) {
      const x = ox + p.x
      const y = oy + p.y
      if (!inBounds(x, y)) return null
      const idx = y * gridSize + x
      if (revealedSand.has(idx) || revealedCrab.has(idx)) return null
      const rn = revealedTreasureName.get(idx)
      if (rn !== undefined && !namesMatch(rn, p.name)) return null
      if (committedCellOrigin.has(idx)) return null
      plots.set(idx, p.name)
    }
    // Sand-adjacency: no plot may sit orthogonally next to revealed sand.
    for (const idx of plots.keys()) {
      const px = idx % gridSize
      const py = Math.floor(idx / gridSize)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx
        const ny = py + dy
        if (!inBounds(nx, ny)) continue
        const nIdx = ny * gridSize + nx
        if (revealedSand.has(nIdx) && !plots.has(nIdx)) return null
      }
    }
    return plots
  }

  // Names for guaranteed tiles, merged across every anchor. Unambiguous entries
  // land in `guaranteedNames`; once two anchors disagree on the name for the same
  // guaranteed tile, it moves to `ambiguousIdx` (index stays guaranteed, but we
  // can no longer say WHICH treasure — so no image is shown).
  const guaranteedNames = new Map() // idx -> display name (unambiguous so far)
  const ambiguousIdx = new Set()
  // Disputed names for guaranteed-but-ambiguous cells, unioned across every
  // anchor/candidate that touched the cell (idx -> Set<slug>). Pure reporting:
  // feeds the UI's "?" tooltip with the possible identities; never influences
  // deduction. Cleared the moment the cell is ever confirmed (see
  // recordConfirmedPlots), at which point its name is ground truth.
  const ambiguousCandidates = new Map()

  const markAmbiguous = (idx, names) => {
    ambiguousIdx.add(idx)
    guaranteedNames.delete(idx)
    let set = ambiguousCandidates.get(idx)
    if (!set) { set = new Set(); ambiguousCandidates.set(idx, set) }
    for (const n of names) set.add(normName(n))
  }

  const recordName = (idx, name) => {
    if (ambiguousIdx.has(idx)) {
      // Keep accumulating the possible identities for reporting — a cell can
      // be touched by several anchors, each adding a candidate name.
      ambiguousCandidates.get(idx)?.add(normName(name))
      return
    }
    if (guaranteedNames.has(idx)) {
      if (!namesMatch(guaranteedNames.get(idx), name)) {
        markAmbiguous(idx, [guaranteedNames.get(idx), name])
      }
    } else {
      guaranteedNames.set(idx, name)
    }
  }

  // Intersect a set of legal placements (Map<idx,name>): a tile that is a
  // treasure-plot in EVERY candidate is guaranteed. Names merge across anchors
  // via recordName; a tile the candidates name differently is demoted.
  const intersectCandidates = (candidates) => {
    if (!candidates.length) return
    const [first, ...rest] = candidates
    for (const [idx] of first) {
      if (!rest.every(c => c.has(idx))) continue
      guaranteed.add(idx)
      const names = new Set(candidates.map(c => normName(c.get(idx))))
      if (names.size === 1) recordName(idx, first.get(idx))
      else markAmbiguous(idx, names)
    }
  }

  // Record the cells of a placement KNOWN to be the one true confirmed
  // instance (i.e. the sole candidate/survivor, always paired with a
  // recordConfirmedInstance call) — as opposed to intersectCandidates, which
  // may be merging several STILL-LIVE alternatives that haven't been
  // eliminated yet. Bypasses (and overrides) `ambiguousIdx`: an earlier pass
  // may have provisionally called a cell ambiguous because, at the time, a
  // competing candidate for a DIFFERENT anchor also touched it and disagreed
  // on the name — but once a candidate is eliminated (its shape's
  // remainingCount hits 0 or it's excluded by committedCellOrigin), that
  // disagreement is moot. A confirmed instance's names are ground truth and
  // can never later contradict themselves (committedCellOrigin locks an idx
  // to its first-confirmed origin forever), so overriding a stale ambiguous
  // mark here is always safe.
  // Collects the placements of CONFIRMED instances (deduped by signature), so
  // the global-consistency search (Pass 5) can treat them as fixed ground
  // truth rather than re-solving them.
  const confirmedPlacements = []
  const confirmedPlacementSet = new Set()

  const recordConfirmedPlots = (plots) => {
    const sig = placementSignature(plots)
    if (!confirmedPlacementSet.has(sig)) {
      confirmedPlacementSet.add(sig)
      confirmedPlacements.push(plots)
    }
    for (const [idx, name] of plots) {
      guaranteed.add(idx)
      ambiguousIdx.delete(idx)
      ambiguousCandidates.delete(idx)
      guaranteedNames.set(idx, name)
    }
  }

  // Shape bookkeeping for single-instance reasoning (Passes 2 & 3). Depends
  // only on patternKeys/DIGGING_FORMATIONS, not on reveals, so it's computed
  // once outside the iterative loop below.
  const shapeCount = new Map() // key -> occurrences (duplicates preserved)
  for (const key of patternKeys) shapeCount.set(key, (shapeCount.get(key) ?? 0) + 1)

  // Remaining instance count per key — decremented when Phase A locks an actual
  // reveal to a unique placement. Once a key reaches 0, no further candidates
  // of that shape are generated, unblocking other anchors that were ambiguous
  // only because of the now-committed instance.
  const remainingCount = new Map(shapeCount)

  const presentKeys = [...new Set(patternKeys)].filter(
    key => Array.isArray(DIGGING_FORMATIONS[key]) && DIGGING_FORMATIONS[key].length,
  )

  // normalized treasure name -> set of present shape keys whose plots use it.
  const nameToKeys = new Map()
  for (const key of presentKeys) {
    for (const p of DIGGING_FORMATIONS[key]) {
      const n = normName(p.name)
      if (!nameToKeys.has(n)) nameToKeys.set(n, new Set())
      nameToKeys.get(n).add(key)
    }
  }
  // A name is "confined to key" iff, among present shapes, only `key` owns it.
  // Static by name only — does NOT account for a same-name sibling shape
  // having already been fully consumed (remainingCount 0). See
  // `revealIsExclusiveTo` below for the dynamic version Pass 2/3 actually use.
  const confinedTo = (name, key) => {
    const keys = nameToKeys.get(normName(name))
    return keys && keys.size === 1 && keys.has(key)
  }

  // Every still-live candidate placement (any shape with remainingCount > 0)
  // that could explain revealed/pseudo-revealed treasure `tName` at `tIdx`.
  // Hoisted above the iterative loop (rather than redefined each pass) so
  // Pass 2/3's dynamic-confinement check below can call it too. Reads
  // `remainingCount`/`committedCellOrigin` by closure — both are declared
  // further down in this function but never invoked until inside the
  // iterative loop, by which point they're initialized (same pattern already
  // relied on by `enumerateSingleInstanceSurvivors` referencing
  // `committedCellOrigin`).
  const computeCandidates = (tIdx, tName) => {
    const origin = committedCellOrigin.get(tIdx)
    if (origin) return [origin]

    const tx = tIdx % gridSize
    const ty = Math.floor(tIdx / gridSize)
    const candidates = []
    for (const { key, formation } of shapes) {
      if ((remainingCount.get(key) ?? 0) === 0) continue
      for (const anchor of formation) {
        if (!namesMatch(anchor.name, tName)) continue
        const ox = tx - anchor.x
        const oy = ty - anchor.y
        const plots = buildPlacement(key, formation, ox, oy)
        if (!plots) continue
        // Cross-check for single-remaining-instance shapes: every revealed
        // treasure whose name is confined to this key — and not already
        // attributed to a previously committed (consumed) instance — must be
        // covered by this candidate. There is no other instance left to explain
        // uncovered reveals, so any candidate that misses one is impossible.
        if ((remainingCount.get(key) ?? 0) === 1) {
          const hasUncovered = [...revealedTreasureName].some(
            ([rIdx, rName]) =>
              confinedTo(rName, key) &&
              !committedCellOrigin.has(rIdx) &&
              !plots.has(rIdx),
          )
          if (hasUncovered) continue
        }
        candidates.push({ key, plots })
      }
    }
    return candidates
  }

  // Dynamic (per-reveal) confinement: true iff, given the board's CURRENT
  // state (including sibling shapes of the same name already consumed this
  // run), `key` is the ONLY shape that can explain this specific reveal.
  // Strictly more precise than `confinedTo` (which only ever looks at static
  // name ownership and can never notice a sibling shape running out) — e.g.
  // three formations sharing "Camel Bone"/seasonal-artefact names are never
  // `confinedTo` any one of them, but once two of the three are pinned to
  // their true placements, a reveal that only the third's remaining
  // candidates can cover becomes dynamically exclusive to it. Used by Pass 2/3
  // (not by computeCandidates' own internal cross-check above, to avoid
  // unbounded recursion re-deriving the very candidates being computed).
  const revealIsExclusiveTo = (idx, name, key) => {
    if (committedCellOrigin.has(idx)) return false
    const cands = computeCandidates(idx, name)
    return cands.length > 0 && cands.every(c => c.key === key)
  }

  // Enumerate every still-legal placement of `key` across the whole board
  // (multi-remaining-instance shapes use this — the global-consistency search
  // picks N pairwise non-overlapping placements from it).
  const enumerateAllPlacements = (key) => {
    const formation = DIGGING_FORMATIONS[key]
    const minX = Math.min(...formation.map(p => p.x))
    const maxX = Math.max(...formation.map(p => p.x))
    const minY = Math.min(...formation.map(p => p.y))
    const maxY = Math.max(...formation.map(p => p.y))
    const allPlacements = []
    for (let oy = -minY; oy <= gridSize - 1 - maxY; oy++) {
      for (let ox = -minX; ox <= gridSize - 1 - maxX; ox++) {
        const plots = buildPlacement(key, formation, ox, oy)
        if (plots) allPlacements.push(plots)
      }
    }
    return allPlacements
  }

  // Enumerate every still-legal placement of a single-instance formation
  // `key`, against whatever `revealedTreasureName` holds at call time. If a
  // revealed (or pseudo-revealed) treasure name is (dynamically) confined to
  // this shape, anchor on it — cheap and exact (Pass 2's approach). Otherwise
  // fall back to full-board enumeration (Pass 3's approach). Shared by
  // Pass 2, Pass 3, and the whole-pattern-guarantee finalization below.
  const enumerateSingleInstanceSurvivors = (key) => {
    const formation = DIGGING_FORMATIONS[key]
    const confined = [...revealedTreasureName].filter(
      ([idx, name]) => revealIsExclusiveTo(idx, name, key),
    )

    if (confined.length) {
      const [aIdx, aName] = confined[0]
      const ax = aIdx % gridSize
      const ay = Math.floor(aIdx / gridSize)
      const survivors = []
      for (const anchor of formation) {
        if (!namesMatch(anchor.name, aName)) continue
        const plots = buildPlacement(key, formation, ax - anchor.x, ay - anchor.y)
        if (!plots) continue
        const coversAll = confined.every(([cIdx, cName]) => namesMatch(plots.get(cIdx), cName))
        if (coversAll) survivors.push(plots)
      }
      return survivors
    }

    return enumerateAllPlacements(key)
  }

  // ── Iterative deduction ──────────────────────────────────────────────
  // Each iteration runs three passes, then promotes any newly-guaranteed cell
  // with a known (unambiguous) name into `revealedTreasureName` as a
  // "pseudo-reveal": a cell already proven to be treasure T constrains other
  // formations' placements exactly the way an actually-dug treasure T would.
  // buildPlacement only ever REJECTS a placement that conflicts with a
  // pseudo-reveal's name, so this can only shrink candidate sets — it can
  // never manufacture a false guarantee. The loop stops once a pass produces
  // no new promotable cells.
  const pseudoRevealed = new Set()

  // A single surviving candidate for a treasure anchor pins that placement as
  // the real instance, regardless of whether the shape has 1 or N occurrences
  // on the board (same soundness argument either way — see Pass 1 below). We
  // remember WHICH instance was pinned, per key, keyed by a canonical
  // signature of its cell indices, so finalization can count how many
  // DISTINCT instances of a duplicated shape are individually proven. A
  // Set<signature> (not a counter) is required because the same real instance
  // can be independently re-confirmed by two different anchors within it
  // (e.g. two plots sharing a name) — deduping by signature avoids
  // double-counting one instance as two.
  const confirmedInstances = new Map() // key -> Set<signature>

  const placementSignature = (plots) => [...plots.keys()].sort((a, b) => a - b).join(',')

  // idx -> the exact {key, plots} that a confirmed instance pinned it to.
  // Once a key is fully consumed (remainingCount reaches 0), computeCandidates
  // stops generating that key's placements — but a pseudo-revealed cell that
  // came FROM that consumed instance still needs re-explaining every time
  // Phase A/B re-examines it as an anchor. Without this map, the search would
  // exclude the (correct, but now-consumed) key and could latch onto a
  // different, spurious single-candidate explanation for the same cell — a
  // real false positive (e.g. re-deriving a since-consumed ARTEFACT_TWENTY_THREE
  // cell as an alternate, wrong ARTEFACT_TWENTY placement). Short-circuiting
  // to the already-known origin avoids ever re-searching for an anchor whose
  // answer is already settled.
  const committedCellOrigin = new Map() // idx -> { key, plots }

  // Returns true iff this signature was not already recorded for `key` — i.e.
  // this call establishes a NEW instance rather than re-confirming one already
  // known. Callers use this (not "was this anchor a real dig?") to decide
  // whether to consume a remainingCount slot: two different real-dug anchors
  // (e.g. Vase then Hieroglyph) can both independently confirm the SAME
  // instance, and only the first such confirmation may consume a slot —
  // otherwise a single real instance gets double-counted as two, starving
  // remainingCount before any evidence of the second real instance exists.
  const recordConfirmedInstance = (key, plots) => {
    if (!confirmedInstances.has(key)) confirmedInstances.set(key, new Set())
    const sig = placementSignature(plots)
    const set = confirmedInstances.get(key)
    const isNewInstance = !set.has(sig)
    set.add(sig)
    for (const idx of plots.keys()) {
      if (!committedCellOrigin.has(idx)) committedCellOrigin.set(idx, { key, plots })
    }
    return isNewInstance
  }

  let iterChanged = true
  while (iterChanged) {
    iterChanged = false

    // ── Pass 1: treasure-anchored deduction ────────────────────────────
    // Two-phase to avoid anchor-ordering ambiguity:
    //   Phase A — single-candidate anchors promote their cells immediately so
    //             subsequent anchors in Phase B see tighter constraints.
    //   Phase B — recompute all candidates (some may now be blocked) and intersect.
    //
    // Why sound: a single-candidate anchor means exactly one placement is legal
    // for that revealed treasure — all its cells are certain. Promoting them
    // before Phase B is equivalent to the end-of-iteration promotion, just earlier.
    // (computeCandidates itself is hoisted above the loop — see its definition
    // near enumerateSingleInstanceSurvivors — since Pass 2/3's dynamic
    // confinement check needs to call it too.)

    // Phase A: immediately promote single-candidate anchors.
    // Only actual reveals (not pseudo-reveals) source instance-consumption locks —
    // pseudo-revealed cells are already attributed to a committed formation instance
    // and must not be used to consume a second one. Likewise, a second real-dug
    // anchor that re-confirms an ALREADY-recorded instance (e.g. both the Vase and
    // the Hieroglyph of the same HIEROGLYPH placement got dug) must not consume a
    // second slot — see recordConfirmedInstance's isNewInstance.
    for (const [tIdx, tName] of revealedTreasureName) {
      const candidates = computeCandidates(tIdx, tName)
      if (candidates.length !== 1) continue
      const { key, plots } = candidates[0]
      const isNewInstance = recordConfirmedInstance(key, plots)
      // Guarantee immediately — Phase B won't see this anchor if the instance
      // is consumed below (count drops to 0), so we can't rely on Phase B.
      // recordConfirmedPlots (not intersectCandidates): this IS the one true
      // confirmed instance, so its names are ground truth even if an earlier
      // pass this same iteration had provisionally flagged one of these cells
      // ambiguous against a since-eliminated alternative.
      recordConfirmedPlots(plots)
      // Consume the instance only when the anchor is a real dug tile AND this is
      // the first confirmation of this specific instance.
      if (!pseudoRevealed.has(tIdx) && isNewInstance) {
        const rem = remainingCount.get(key) ?? 0
        if (rem > 0) {
          remainingCount.set(key, rem - 1)
          iterChanged = true
        }
      }
      for (const [idx, name] of plots) {
        if (!revealedTreasureName.has(idx) && !pseudoRevealed.has(idx)) {
          revealedTreasureName.set(idx, name)
          pseudoRevealed.add(idx)
          iterChanged = true
        }
      }
    }

    // Phase B: recompute with Phase A promotions applied, then intersect.
    // Mirrors Phase A's consume-on-confirm: a single-candidate anchor found
    // only here (not in Phase A) still pins a real instance and must consume
    // its remainingCount slot — otherwise other anchors keep seeing this
    // already-confirmed shape as a live competing hypothesis forever (it can
    // never reach candidates.length === 1 for them, since the confirmed
    // instance's own reveal keeps re-adding it as a candidate).
    for (const [tIdx, tName] of revealedTreasureName) {
      const candidates = computeCandidates(tIdx, tName)
      if (!candidates.length) continue // inconsistent — skip safely
      if (candidates.length === 1) {
        const { key, plots } = candidates[0]
        const isNewInstance = recordConfirmedInstance(key, plots)
        if (!pseudoRevealed.has(tIdx) && isNewInstance) {
          const rem = remainingCount.get(key) ?? 0
          if (rem > 0) {
            remainingCount.set(key, rem - 1)
            iterChanged = true
          }
        }
        recordConfirmedPlots(plots)
      } else {
        intersectCandidates(candidates.map(c => c.plots))
      }
    }

    // ── Pass 2: single-instance forcing ─────────────────────────────────
    // When exactly one formation of a shape is on the board, every revealed
    // treasure that (dynamically — see revealIsExclusiveTo) can ONLY be
    // explained by that shape must belong to that single instance.
    // Enumerating the instance's legal placements that cover all such
    // reveals and intersecting them pins the in-between tiles even when
    // nothing adjacent has been dug.
    for (const key of presentKeys) {
      if (remainingCount.get(key) !== 1) continue
      const hasConfinedReveal = [...revealedTreasureName].some(([idx, name]) => revealIsExclusiveTo(idx, name, key))
      if (!hasConfinedReveal) continue

      const survivors = enumerateSingleInstanceSurvivors(key)
      if (!survivors.length) continue // inconsistent data — skip safely
      // A single survivor pins this shape's one remaining instance, exactly
      // like Phase A/B's single-candidate anchors — must consume its
      // remainingCount slot too, or shapes sharing its treasure names (e.g.
      // three artefact formations sharing "Camel Bone") keep seeing it as a
      // live competing hypothesis forever (see the Phase B regression this
      // mirrors, in the 2026-07-27 snapshot test above).
      if (survivors.length === 1) {
        const isNewInstance = recordConfirmedInstance(key, survivors[0])
        if (isNewInstance) {
          const rem = remainingCount.get(key) ?? 0
          if (rem > 0) { remainingCount.set(key, rem - 1); iterChanged = true }
        }
        recordConfirmedPlots(survivors[0])
      } else {
        intersectCandidates(survivors)
      }
    }

    // ── Pass 3: pure-elimination ─────────────────────────────────────────
    // For a single-instance formation with no (dynamically) confined-name
    // reveal to anchor on, enumerate EVERY legal placement across the whole
    // board. If sand, crab, edges, and (from prior iterations) pseudo-reveals
    // rule out all but one, that lone survivor's cells are guaranteed.
    for (const key of presentKeys) {
      if (remainingCount.get(key) !== 1) continue
      const hasConfinedReveal = [...revealedTreasureName].some(([idx, n]) => revealIsExclusiveTo(idx, n, key))
      if (hasConfinedReveal) continue // Pass 2 already covers this shape with a tighter candidate set

      const allPlacements = enumerateSingleInstanceSurvivors(key)
      if (allPlacements.length === 1) {
        const isNewInstance = recordConfirmedInstance(key, allPlacements[0])
        if (isNewInstance) {
          const rem = remainingCount.get(key) ?? 0
          if (rem > 0) { remainingCount.set(key, rem - 1); iterChanged = true }
        }
        recordConfirmedPlots(allPlacements[0])
      }
    }

    // ── Pass 4: crab-satisfaction forcing ────────────────────────────────
    // Every crab borders at least one treasure. If a crab has no known treasure
    // neighbour yet and exactly one candidate neighbour remains, that neighbour
    // must be the treasure. Only marks the cell guaranteed (no name known).
    for (const cIdx of revealedCrab) {
      const cx = cIdx % gridSize
      const cy = Math.floor(cIdx / gridSize)
      const ns = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => [cx + dx, cy + dy])
        .filter(([nx, ny]) => inBounds(nx, ny))

      const satisfied = ns.some(([nx, ny]) => {
        const nIdx = ny * gridSize + nx
        return revealedTreasureName.has(nIdx) || guaranteed.has(nIdx)
      })
      if (satisfied) continue

      const candidates = ns.filter(([nx, ny]) => {
        const nIdx = ny * gridSize + nx
        if (revealedSand.has(nIdx) || revealedCrab.has(nIdx) || revealedTreasureName.has(nIdx)) return false
        return ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const sx = nx + dx
          const sy = ny + dy
          return inBounds(sx, sy) && revealedSand.has(sy * gridSize + sx) &&
            !(sx === cx && sy === cy)
        })
      })
      if (candidates.length === 1) {
        const [nx, ny] = candidates[0]
        const nIdx = ny * gridSize + nx
        if (!guaranteed.has(nIdx)) { guaranteed.add(nIdx); iterChanged = true }
      }
    }

    // ── Pass 5: global-consistency name disambiguation ───────────────────
    // The per-anchor local passes are sound but incomplete: a cell can be
    // provably a treasure while its NAME is only provable via global
    // constraints — every formation instance occurs exactly once, placements
    // may not overlap, and every revealed treasure must be covered by exactly
    // one placement. Live case: C4=CB + D5=OP are diagonal, so no straight-line
    // artefact (FIFTEEN/TWENTY_FOUR) can cover both — only SEVENTEEN's L can —
    // hence D4 is provably Camel Bone even though the local passes saw
    // disagreeing candidates. For each disputed name, run a bounded exact
    // search for a full consistent assignment in which the cell carries that
    // name; names with NO consistent assignment are eliminated.
    //
    // Soundness: the real board's placement of every remaining instance is one
    // of the enumerated legal placements, so "no consistent assignment with
    // name n at cell X" ⇒ the real board does not name X=n ⇒ eliminating n is
    // sound. The search checks placement legality (buildPlacement), non-overlap
    // and reveal coverage; it deliberately ignores crab-satisfaction — a more
    // permissive search can only KEEP names it shouldn't (cell stays
    // ambiguous), never eliminate a real one. Budget exhaustion yields no
    // conclusion (stays ambiguous — never a wrong name).
    if (ambiguousCandidates.size) {
      const groups = []
      let groupsValid = true
      for (const key of presentKeys) {
        const need = remainingCount.get(key) ?? 0
        if (need === 0) continue
        const placements = need === 1
          ? enumerateSingleInstanceSurvivors(key)
          : enumerateAllPlacements(key)
        if (!placements.length || placements.length < need) { groupsValid = false; break }
        groups.push({ key, need, placements })
      }
      // Most-constrained first: fewest placement options → fewest branches.
      groups.sort((a, b) => a.placements.length - b.placements.length)

      const BUDGET = Symbol('budget')
      const fixedCovered = new Set()
      for (const plots of confirmedPlacements) {
        for (const idx of plots.keys()) fixedCovered.add(idx)
      }

      // Find ANY full assignment (fixed placements + one non-overlapping
      // placement per remaining instance) covering every revealed treasure
      // cell. `extraReveals` adds a hypothetical reveal (cell → name) so we
      // can test "could this cell be name n?". Returns true/false, or null on
      // budget.
      //
      // Search strategy — backtrack over REVEALS, most-constrained first
      // (a reveal with 1-2 covering placements prunes the tree far harder
      // than a shape with 50 free placements), with sound reductions:
      //  - a placement that CONTAINS a reveal cell but names it wrongly is
      //    invalid (matters for the hypothetical extra reveals — the real
      //    ones are already enforced by buildPlacement);
      //  - shapes that end up covering no reveal ("floated") only need SOME
      //    non-overlapping placement to exist — checked once at the leaf.
      const search = (extraReveals) => {
        const revealName = new Map(revealedTreasureName)
        for (const [idx, name] of extraReveals) revealName.set(idx, name)

        // Per-group precomputation: placement conflict flags (extra reveals
        // only — regular ones are guaranteed clean by buildPlacement).
        const groupPlacementOk = groups.map(g => g.placements.map(p => {
          for (const [eIdx, eName] of extraReveals) {
            const n = p.get(eIdx)
            if (n !== undefined && !namesMatch(n, eName)) return false
          }
          return true
        }))

        // Options per reveal: which (group, placement) can cover it correctly.
        const options = new Map()
        for (const [idx, name] of revealName) {
          if (fixedCovered.has(idx)) continue
          const opts = []
          for (let gi = 0; gi < groups.length; gi++) {
            const { placements } = groups[gi]
            for (let pi = 0; pi < placements.length; pi++) {
              const n = placements[pi].get(idx)
              if (n !== undefined && namesMatch(n, name) && groupPlacementOk[gi][pi]) {
                opts.push([gi, pi])
              }
            }
          }
          options.set(idx, opts)
        }

        const slots = groups.map(g => g.need)
        const placed = []
        const occupied = new Set(fixedCovered)
        const covered = new Set(fixedCovered)
        let nodes = 0

        const uncoveredReveals = () => {
          const out = []
          for (const idx of revealName.keys()) {
            if (!covered.has(idx)) out.push(idx)
          }
          return out
        }

        const floatsOk = () => {
          for (let gi = 0; gi < groups.length; gi++) {
            if (slots[gi] === 0) continue
            const { placements } = groups[gi]
            let ok = false
            for (let pi = 0; pi < placements.length; pi++) {
              if (!groupPlacementOk[gi][pi]) continue
              if (![...placements[pi].keys()].some(idx => occupied.has(idx))) { ok = true; break }
            }
            if (!ok) return false
          }
          return true
        }

        const bt = () => {
          if (++nodes > 50000) throw BUDGET
          const uncovered = uncoveredReveals()
          if (!uncovered.length) return floatsOk()

          // Most-constrained reveal first: fewest live options.
          let best = null
          for (const idx of uncovered) {
            const live = options.get(idx).filter(([gi]) => slots[gi] > 0)
            if (!live.length) return false // a reveal nobody can cover → dead end
            if (!best || live.length < best.live.length) best = { idx, live }
          }
          const { idx, live } = best

          for (const [gi, pi] of live) {
            const p = groups[gi].placements[pi]
            if ([...p.keys()].some(i => occupied.has(i))) continue
            // Apply: occupy, cover, consume a slot of group gi.
            const pKeys = [...p.keys()]
            for (const i of pKeys) occupied.add(i)
            for (const i of pKeys) covered.add(i)
            slots[gi] -= 1
            placed.push(p)
            if (bt()) return true
            placed.pop()
            slots[gi] += 1
            for (const i of pKeys) covered.delete(i)
            for (const i of pKeys) occupied.delete(i)
          }
          return false
        }

        try { return bt() } catch (e) {
          if (e === BUDGET) return null
          throw e
        }
      }

      const toResolve = [...ambiguousCandidates.keys()]
      for (const idx of toResolve) {
        const names = [...ambiguousCandidates.get(idx)]
        const possible = []
        let budgetHit = false
        for (const n of names) {
          const ok = search(new Map([[idx, n]]))
          if (ok === true) possible.push(n)
          else if (ok === null) { budgetHit = true; break }
        }
        if (budgetHit) continue // no conclusions this iteration — stay conservative
        if (possible.length === 1) {
          // Exactly one disputed name survives global consistency → provable.
          guaranteedNames.set(idx, possible[0])
          ambiguousCandidates.delete(idx)
          ambiguousIdx.delete(idx)
          iterChanged = true
        }
        // possible.length === 0 → the revealed state contradicts the game
        // rules; keep ambiguous rather than manufacture a name.
      }
    }

    // Promote newly-guaranteed, unambiguously-named cells into
    // revealedTreasureName so the next iteration can use them as spatial
    // constraints for other formations (e.g. a single-instance shape whose
    // last ambiguity depends on treating this cell as taken). Ambiguous
    // guaranteed cells (unknown name) are intentionally left alone — treating
    // them as "unavailable to other formations" could wrongly eliminate the
    // real placement of a different shape.
    for (const [idx, name] of guaranteedNames) {
      if (!revealedTreasureName.has(idx) && !pseudoRevealed.has(idx)) {
        revealedTreasureName.set(idx, name)
        pseudoRevealed.add(idx)
        iterChanged = true
      }
    }
  }

  const guaranteedSlugs = new Map()
  for (const [idx, name] of guaranteedNames) {
    guaranteedSlugs.set(idx, slugify(name))
  }

  // Disputed-name reporting for guaranteed-but-ambiguous cells (UI "?" tooltip):
  // idx -> possible treasure slugs, unioned across every candidate that touched
  // the cell. Absent for named cells. Read-only info — never used in deduction.
  const guaranteedCandidates = new Map()
  for (const [idx, names] of ambiguousCandidates) {
    guaranteedCandidates.set(idx, [...names])
  }

  // ── Whole-pattern-guarantee finalization ────────────────────────────
  // For each present key, the count of individually-proven instances is the
  // number of distinct signatures Pass 1 pinned for it (sound regardless of
  // shapeCount — two real formation instances can never occupy overlapping
  // cells, so N distinct confirmed signatures means N real instances are
  // individually known, full stop). When exactly one instance of a key
  // remains uncommitted (remainingCount === 1 — true for originally
  // single-instance shapes, and also for a duplicated shape once its other
  // instances have been consumed by Pass 1), also fold in the confined-name/
  // full-board enumeration route (e.g. COCKLE/SEAWEED, or the last instance
  // of a cascade-consumed duplicate) — but only bump the count if that
  // survivor's signature isn't already one of the confirmed ones, since
  // enumerateSingleInstanceSurvivors re-derives the SAME instance Pass 1 may
  // have already confirmed (double-counting it would overcount past the
  // real number of instances on the board).
  const guaranteedFormationCounts = new Map()
  for (const key of presentKeys) {
    const confirmed = confirmedInstances.get(key)
    let count = confirmed?.size ?? 0
    if (remainingCount.get(key) === 1) {
      const survivors = enumerateSingleInstanceSurvivors(key)
      if (survivors.length === 1 && !confirmed?.has(placementSignature(survivors[0]))) {
        count += 1
      }
    }
    if (count > 0) guaranteedFormationCounts.set(key, count)
  }

  // ── Layer 3: remaining-instance reporting ────────────────────────────
  // Pure reporting — never feeds deduction. For every shape with unconfirmed
  // instances left, HOW MANY remain and WHICH cells can still host one of
  // them. A region is the union of all still-legal placements (buildPlacement
  // already excludes sand/crab/name-mismatch/committed cells), so a cell
  // absent from every region is provably NOT an undiscovered treasure — the
  // complement of `guaranteed`. This answers "what's still out there, and
  // where can it still be?" for the UI.
  const remainingCounts = new Map()
  const remainingRegions = new Map()
  for (const key of presentKeys) {
    const rem = remainingCount.get(key) ?? 0
    if (rem === 0) continue
    remainingCounts.set(key, rem)
    // Tighter survivor set when a single instance remains (Pass 2/3
    // semantics), full-board enumeration otherwise — same sets the solver
    // itself reasons over, so the report can never contradict the deduction.
    const placements = rem === 1
      ? enumerateSingleInstanceSurvivors(key)
      : enumerateAllPlacements(key)
    const region = new Set()
    for (const p of placements) {
      for (const idx of p.keys()) region.add(idx)
    }
    remainingRegions.set(key, region)
  }
  const possibleTreasureCells = new Set()
  for (const region of remainingRegions.values()) {
    for (const idx of region) possibleTreasureCells.add(idx)
  }

  // ── Probability layer: enumerate globally-consistent remaining boards ──
  // Opt-in only: Guaranteed mode must stay fast on mobile. Percentages are
  // reported only after an EXHAUSTIVE search. A capped deterministic DFS is
  // not an unbiased sample, so partial results are deliberately discarded.
  let probabilities = new Map()
  let targetProbabilities = new Map()
  let globalSolutionCount = 0
  let probabilityComplete = true
  let probabilityReason = null
  let probabilityMode = 'none'
  let smartDig = null
  let smartDigRanking = []
  let targetPlan = null
  let targetComplete = false
  let targetRequiredCount = 0
  let targetFoundCount = 0
  let targetRemainingCount = 0
  let targetLayoutCount = 0

  if (includeProbabilities) {
    const probabilityCounts = new Map() // idx -> Map<slug,count>
    const outcomeCounts = new Map() // idx -> Map<outcome,count>, exact boards only
    // Target-aware joint distribution: cell -> outcome -> target-layout signature -> count.
    // This lets Smart Dig value only information that changes where the selected
    // treasure can be, instead of being distracted by e.g. Old Bottle ambiguity.
    const targetJointCounts = new Map()
    const targetSignatureCounts = new Map()
    const targetSolutionCells = [] // exact solutions only; each entry is a small sorted idx[]
    const solutionOutcomeCodes = [] // exact solutions; Uint8Array over all cells
    const outcomeCodeByName = new Map([['sand', 1], ['crab', 2]])
    let nextOutcomeCode = 3
    const normalizedProbabilityTarget = slugify(probabilityTarget)

    if (normalizedProbabilityTarget) {
      for (const key of patternKeys || []) {
        for (const plot of DIGGING_FORMATIONS[key] || []) {
          if (slugify(plot.name) === normalizedProbabilityTarget) {
            targetRequiredCount += 1
          }
        }
      }

      for (const name of actuallyRevealedTreasureName.values()) {
        if (slugify(name) === normalizedProbabilityTarget) {
          targetFoundCount += 1
        }
      }

      targetRemainingCount = Math.max(0, targetRequiredCount - targetFoundCount)
      targetComplete =
        targetRequiredCount > 0 &&
        targetFoundCount >= targetRequiredCount
    }

    const probabilityGroups = []
    let probabilityGroupsValid = true

    for (const key of presentKeys) {
      const need = remainingCount.get(key) ?? 0
      if (need === 0) continue
      const placements = need === 1
        ? enumerateSingleInstanceSurvivors(key)
        : enumerateAllPlacements(key)
      if (placements.length < need) {
        probabilityGroupsValid = false
        break
      }
      probabilityGroups.push({ key, need, placements })
    }

    // Pre-filter single-instance groups with revealed treasure names that can
    // only belong to that remaining formation key. This is exact (not a
    // heuristic) and massively reduces the global search on real boards.
    const fixedProbabilityCells = new Set()
    for (const plots of confirmedPlacements) {
      for (const idx of plots.keys()) fixedProbabilityCells.add(idx)
    }

    if (probabilityGroupsValid) {
      const exclusiveRevealsByKey = new Map()
      for (const [idx, name] of revealedTreasureName) {
        if (fixedProbabilityCells.has(idx)) continue

        const owners = probabilityGroups.filter(group =>
          DIGGING_FORMATIONS[group.key]?.some(plot => namesMatch(plot.name, name)),
        )

        if (owners.length === 1 && owners[0].need === 1) {
          const key = owners[0].key
          if (!exclusiveRevealsByKey.has(key)) exclusiveRevealsByKey.set(key, [])
          exclusiveRevealsByKey.get(key).push([idx, name])
        }
      }

      for (const group of probabilityGroups) {
        const required = exclusiveRevealsByKey.get(group.key)
        if (!required?.length) continue
        group.placements = group.placements.filter(plots =>
          required.every(([idx, name]) => namesMatch(plots.get(idx), name)),
        )
        if (group.placements.length < group.need) {
          probabilityGroupsValid = false
          break
        }
      }
    }

    probabilityGroups.sort((a, b) =>
      (a.placements.length / Math.max(1, a.need)) -
      (b.placements.length / Math.max(1, b.need))
    )

    if (!probabilityGroupsValid) {
      probabilityComplete = false
      probabilityReason = 'inconsistent'
    } else {
      // Cheap fallback estimate used only when exact global enumeration is too
      // large. It respects every local placement constraint already enforced by
      // buildPlacement/enumerate* but does NOT model cross-formation overlap or
      // crab coupling. The UI marks these values with "~" so they are never
      // presented as exact probabilities.
      const buildLocalEstimate = () => {
        const combined = new Map() // idx -> Map<slug,p>
        const mergeProbability = (idx, slug, p) => {
          if (p <= 0) return
          let byName = combined.get(idx)
          if (!byName) {
            byName = new Map()
            combined.set(idx, byName)
          }
          const prev = byName.get(slug) ?? 0
          byName.set(slug, 1 - ((1 - prev) * (1 - p)))
        }

        // Confirmed placements are certain, including their still-undug cells.
        for (const plots of confirmedPlacements) {
          for (const [idx, name] of plots) {
            mergeProbability(idx, slugify(name), 1)
          }
        }

        for (const { need, placements } of probabilityGroups) {
          if (!placements.length) continue
          const counts = new Map() // idx -> Map<slug,count>
          for (const plots of placements) {
            for (const [idx, name] of plots) {
              const slug = slugify(name)
              let byName = counts.get(idx)
              if (!byName) {
                byName = new Map()
                counts.set(idx, byName)
              }
              byName.set(slug, (byName.get(slug) ?? 0) + 1)
            }
          }

          for (const [idx, byName] of counts) {
            for (const [slug, count] of byName) {
              const oneInstance = count / placements.length
              // Approximate duplicated instances as independent draws. This is
              // intentionally a fallback ranking signal, not an exact board
              // probability; exact enumeration replaces it whenever feasible.
              const p = 1 - Math.pow(1 - oneInstance, need)
              mergeProbability(idx, slug, p)
            }
          }
        }
        return combined
      }

      const localEstimate = buildLocalEstimate()

      // Reduced target-only model for the early/approximate phase.
      //
      // The full-board enumeration often exceeds its budget during the first
      // digs. Falling back to a per-cell local percentage then produces a very
      // flat 4-10% map and effectively chooses the first cell in scan order.
      // Instead, enumerate ONLY the formations that contain the selected
      // target. Their companion objects (e.g. Camel Bone around Otter Pebble)
      // are kept because finding one is highly informative about target
      // location. Unrelated formations are deliberately excluded so they
      // cannot dominate the opening recommendation.
      const buildTargetOpeningModel = () => {
        if (!normalizedProbabilityTarget || targetComplete) return null

        const targetKeys = new Set(
          presentKeys.filter(key =>
            DIGGING_FORMATIONS[key]?.some(
              plot => slugify(plot.name) === normalizedProbabilityTarget,
            ),
          ),
        )
        if (!targetKeys.size) return null

        const targetGroups = probabilityGroups
          .filter(group => targetKeys.has(group.key))
          .map(group => ({
            key: group.key,
            need: group.need,
            placements: group.placements,
          }))

        const fixedTargetPlacements = confirmedPlacements.filter(plots =>
          [...plots.values()].some(
            name => slugify(name) === normalizedProbabilityTarget,
          ),
        )

        // A revealed companion (Camel Bone for artefact patterns) must be
        // explained by the target model only when no non-target daily pattern
        // can own that same object name.
        const targetNames = new Set()
        const nonTargetNames = new Set()
        for (const key of presentKeys) {
          const destination = targetKeys.has(key) ? targetNames : nonTargetNames
          for (const plot of DIGGING_FORMATIONS[key] || []) {
            destination.add(normName(plot.name))
          }
        }
        const targetRelevantReveals = [...revealedTreasureName].filter(
          ([, name]) => {
            const normalized = normName(name)
            return targetNames.has(normalized) && !nonTargetNames.has(normalized)
          },
        )

        const occupiedOpening = new Set(fixedProbabilityCells)
        const chosenOpening = []
        const outcomeCountsOpening = new Map() // idx -> Map<slug,count>
        const targetPresenceCountsOpening = new Map() // target idx -> configurations containing it
        const openingJointCounts = new Map() // first idx -> outcome slug -> target idx -> count
        // Keep compact target-bearing configurations only while the reduced
        // search is small enough for deeper expected-cost planning. Large
        // openings still use the cheap aggregate model and do not pay this
        // memory cost.
        const openingRecords = []
        let openingRecordsComplete = true
        const OPENING_DEEP_CONFIG_CAP = 12000
        let configurationCount = 0
        let openingNodes = 0
        let openingAborted = false
        const OPENING_CONFIGURATION_CAP = 750000
        const OPENING_NODE_CAP = 2000000

        const recordOpeningConfiguration = () => {
          const cellsInConfiguration = new Map()
          for (const plots of [...fixedTargetPlacements, ...chosenOpening]) {
            for (const [idx, name] of plots) cellsInConfiguration.set(idx, name)
          }

          // Enforce all reveals that are exclusively owned by target-bearing
          // patterns. This is important once Camel Bones / the target itself
          // start appearing during the session.
          for (const [idx, name] of targetRelevantReveals) {
            if (!namesMatch(cellsInConfiguration.get(idx), name)) return
          }

          configurationCount += 1
          if (configurationCount > OPENING_CONFIGURATION_CAP) {
            openingAborted = true
            return
          }

          const targetCells = [...cellsInConfiguration.entries()]
            .filter(([idx, name]) =>
              !actuallyRevealedCells.has(idx) &&
              slugify(name) === normalizedProbabilityTarget
            )
            .map(([idx]) => idx)
            .sort((a, b) => a - b)

          if (openingRecordsComplete) {
            if (openingRecords.length < OPENING_DEEP_CONFIG_CAP) {
              const hiddenCells = new Map()
              for (const [idx, name] of cellsInConfiguration) {
                if (!actuallyRevealedCells.has(idx)) hiddenCells.set(idx, name)
              }
              openingRecords.push({
                targetCells,
                cells: hiddenCells,
                allCells: new Map(cellsInConfiguration),
              })
            } else {
              openingRecordsComplete = false
              openingRecords.length = 0
            }
          }

          for (const targetIdx of targetCells) {
            targetPresenceCountsOpening.set(
              targetIdx,
              (targetPresenceCountsOpening.get(targetIdx) ?? 0) + 1,
            )
          }

          // "Other" is implicit. Count explicit target-pattern treasure
          // outcomes, plus their joint distribution with every target cell.
          // The implicit "other" joint can then be derived from totals without
          // iterating all 100 cells for every configuration.
          for (const [idx, name] of cellsInConfiguration) {
            if (actuallyRevealedCells.has(idx)) continue
            const slug = slugify(name)
            let byOutcome = outcomeCountsOpening.get(idx)
            if (!byOutcome) {
              byOutcome = new Map()
              outcomeCountsOpening.set(idx, byOutcome)
            }
            byOutcome.set(slug, (byOutcome.get(slug) ?? 0) + 1)

            let jointByOutcome = openingJointCounts.get(idx)
            if (!jointByOutcome) {
              jointByOutcome = new Map()
              openingJointCounts.set(idx, jointByOutcome)
            }
            let targetCounts = jointByOutcome.get(slug)
            if (!targetCounts) {
              targetCounts = new Map()
              jointByOutcome.set(slug, targetCounts)
            }
            for (const targetIdx of targetCells) {
              targetCounts.set(
                targetIdx,
                (targetCounts.get(targetIdx) ?? 0) + 1,
              )
            }
          }
        }

        const chooseOpeningGroup = (groupIndex, startPlacement, left) => {
          if (openingAborted) return
          openingNodes += 1
          if (openingNodes > OPENING_NODE_CAP) {
            openingAborted = true
            return
          }

          if (groupIndex >= targetGroups.length) {
            recordOpeningConfiguration()
            return
          }

          const group = targetGroups[groupIndex]
          if (left === 0) {
            chooseOpeningGroup(
              groupIndex + 1,
              0,
              targetGroups[groupIndex + 1]?.need ?? 0,
            )
            return
          }

          for (let pi = startPlacement; pi < group.placements.length; pi++) {
            if (openingAborted) return
            const plots = group.placements[pi]
            const keys = [...plots.keys()]
            if (keys.some(idx => occupiedOpening.has(idx))) continue

            for (const idx of keys) occupiedOpening.add(idx)
            chosenOpening.push(plots)
            chooseOpeningGroup(groupIndex, pi + 1, left - 1)
            chosenOpening.pop()
            for (const idx of keys) occupiedOpening.delete(idx)
          }
        }

        if (targetGroups.length) {
          chooseOpeningGroup(0, 0, targetGroups[0].need)
        } else {
          // All target-bearing formations are already fixed. This still lets
          // the reduced model point directly at an undug guaranteed target.
          recordOpeningConfiguration()
        }

        if (openingAborted || configurationCount === 0) return null

        // v7 target-centric feasibility filter.
        //
        // The target-only model is cheap, but it can keep target layouts that
        // cannot coexist with the unrelated daily formations. Group records by
        // remaining-target signature and ask an existential question for each
        // layout: does ANY compatible companion configuration have at least one
        // full-board completion? One witness is enough to keep the layout.
        //
        // This is intentionally NOT full enumeration. If the shared feasibility
        // budget is exhausted, unproven layouts are retained (unknown !=
        // impossible), so pruning stays conservative.
        let targetFeasibilityChecked = 0
        let targetFeasibilityRejected = 0
        let targetFeasibilityCapped = false

        if (
          openingRecordsComplete &&
          openingRecords.length === configurationCount &&
          openingRecords.length <= OPENING_DEEP_CONFIG_CAP
        ) {
          const nonTargetGroups = probabilityGroups.filter(
            group => !targetKeys.has(group.key),
          )
          const revealedEntries = [...revealedTreasureName]
          const crabNeighbourIndexes = [...revealedCrab].map(idx => {
            const x = idx % gridSize
            const y = Math.floor(idx / gridSize)
            return [[1, 0], [-1, 0], [0, 1], [0, -1]]
              .map(([dx, dy]) => [x + dx, y + dy])
              .filter(([nx, ny]) => inBounds(nx, ny))
              .map(([nx, ny]) => ny * gridSize + nx)
          })

          let feasibilityNodes = 0
          const FEASIBILITY_NODE_CAP =
            openingRecords.length <= 500 ? 350000 :
              openingRecords.length <= 3000 ? 220000 : 140000

          const recordHasCompletion = record => {
            const occupiedFeasible = new Set()
            const feasibleNames = new Map()

            for (const plots of confirmedPlacements) {
              for (const [idx, name] of plots) {
                occupiedFeasible.add(idx)
                feasibleNames.set(idx, name)
              }
            }
            for (const [idx, name] of record.allCells) {
              occupiedFeasible.add(idx)
              feasibleNames.set(idx, name)
            }

            const revealCovered = (idx, name) =>
              feasibleNames.has(idx) &&
              namesMatch(feasibleNames.get(idx), name)

            const allRevealsCoveredFeasible = () =>
              revealedEntries.every(([idx, name]) => revealCovered(idx, name))

            const allCrabsSatisfiedFeasible = () =>
              crabNeighbourIndexes.every(neighbours =>
                neighbours.some(idx => occupiedFeasible.has(idx))
              )

            const placementFits = plots =>
              ![...plots.keys()].some(idx => occupiedFeasible.has(idx))

            const remainingCanCover = (groupIndex, startPlacement, left, predicate) => {
              for (let gi = groupIndex; gi < nonTargetGroups.length; gi++) {
                const group = nonTargetGroups[gi]
                const from = gi === groupIndex && left > 0 ? startPlacement : 0
                if (gi === groupIndex && left === 0) continue
                for (let pi = from; pi < group.placements.length; pi++) {
                  const plots = group.placements[pi]
                  if (!placementFits(plots)) continue
                  if (predicate(plots)) return true
                }
              }
              return false
            }

            const feasibleRemainder = (groupIndex, startPlacement, left) => {
              for (const [idx, name] of revealedEntries) {
                if (revealCovered(idx, name)) continue
                if (!remainingCanCover(
                  groupIndex,
                  startPlacement,
                  left,
                  plots => namesMatch(plots.get(idx), name),
                )) return false
              }

              for (const neighbours of crabNeighbourIndexes) {
                if (neighbours.some(idx => occupiedFeasible.has(idx))) continue
                if (!remainingCanCover(
                  groupIndex,
                  startPlacement,
                  left,
                  plots => neighbours.some(idx => plots.has(idx)),
                )) return false
              }
              return true
            }

            let found = false
            let capped = false

            const search = (groupIndex, startPlacement, left) => {
              if (found || capped) return
              feasibilityNodes += 1
              if (feasibilityNodes > FEASIBILITY_NODE_CAP) {
                capped = true
                targetFeasibilityCapped = true
                return
              }

              if (groupIndex >= nonTargetGroups.length) {
                if (allRevealsCoveredFeasible() && allCrabsSatisfiedFeasible()) {
                  found = true
                }
                return
              }

              if (!feasibleRemainder(groupIndex, startPlacement, left)) return

              const group = nonTargetGroups[groupIndex]
              if (left === 0) {
                search(
                  groupIndex + 1,
                  0,
                  nonTargetGroups[groupIndex + 1]?.need ?? 0,
                )
                return
              }

              for (let pi = startPlacement; pi < group.placements.length; pi++) {
                if (found || capped) return
                const plots = group.placements[pi]
                const keys = [...plots.keys()]
                if (keys.some(idx => occupiedFeasible.has(idx))) continue

                for (const [idx, name] of plots) {
                  occupiedFeasible.add(idx)
                  feasibleNames.set(idx, name)
                }
                search(groupIndex, pi + 1, left - 1)
                for (const idx of keys) {
                  occupiedFeasible.delete(idx)
                  feasibleNames.delete(idx)
                }
              }
            }

            if (!nonTargetGroups.length) {
              found = allRevealsCoveredFeasible() && allCrabsSatisfiedFeasible()
            } else {
              search(0, 0, nonTargetGroups[0].need)
            }

            return capped ? null : found
          }

          const recordsByTargetSignature = new Map()
          for (const record of openingRecords) {
            const signature = record.targetCells.join(',')
            if (!recordsByTargetSignature.has(signature)) {
              recordsByTargetSignature.set(signature, [])
            }
            recordsByTargetSignature.get(signature).push(record)
          }

          const keptSignatures = new Set()
          for (const [signature, records] of recordsByTargetSignature) {
            if (targetFeasibilityCapped) {
              keptSignatures.add(signature)
              continue
            }

            let layoutFeasible = false
            let layoutUnknown = false
            for (const record of records) {
              const result = recordHasCompletion(record)
              if (result === null) {
                layoutUnknown = true
                break
              }
              if (result) {
                layoutFeasible = true
                break
              }
            }

            if (layoutFeasible || layoutUnknown) {
              keptSignatures.add(signature)
            } else {
              targetFeasibilityRejected += 1
            }
            targetFeasibilityChecked += 1
          }

          if (keptSignatures.size > 0) {
            const feasibleRecords = openingRecords.filter(record =>
              keptSignatures.has(record.targetCells.join(','))
            )
            openingRecords.length = 0
            openingRecords.push(...feasibleRecords)
            configurationCount = feasibleRecords.length
          }
        }

        const deepTargetModel =
          openingRecordsComplete &&
          openingRecords.length === configurationCount &&
          configurationCount <= OPENING_DEEP_CONFIG_CAP

        const openingTargetProbabilities = new Map()
        let openingLayoutCount = 0
        let openingLayoutGroups = null
        let openingRecordWeights = null

        if (deepTargetModel) {
          // Equal prior over DISTINCT remaining-target layouts. Companion
          // placements only define P(outcome | layout), never the prior.
          openingLayoutGroups = new Map()
          for (let ri = 0; ri < openingRecords.length; ri++) {
            const signature = openingRecords[ri].targetCells.join(',')
            if (!openingLayoutGroups.has(signature)) {
              openingLayoutGroups.set(signature, [])
            }
            openingLayoutGroups.get(signature).push(ri)
          }
          openingLayoutCount = openingLayoutGroups.size
          openingRecordWeights = new Array(openingRecords.length).fill(0)

          for (const [signature, recordIndexes] of openingLayoutGroups) {
            const layoutWeight = openingLayoutCount > 0
              ? 1 / openingLayoutCount
              : 0
            const perRecord = recordIndexes.length > 0
              ? layoutWeight / recordIndexes.length
              : 0
            for (const ri of recordIndexes) openingRecordWeights[ri] = perRecord

            if (!signature) continue
            for (const token of signature.split(',')) {
              const idx = Number(token)
              if (!Number.isFinite(idx)) continue
              openingTargetProbabilities.set(
                idx,
                (openingTargetProbabilities.get(idx) ?? 0) + layoutWeight,
              )
            }
          }
        } else {
          // Large opening: retain the low-memory configuration estimate.
          for (const [idx, count] of targetPresenceCountsOpening) {
            openingTargetProbabilities.set(idx, count / configurationCount)
          }
        }

        const ranking = []

        for (const [idx, counts] of outcomeCountsOpening) {
          if (actuallyRevealedCells.has(idx)) continue

          let sumKnown = 0
          let sumSquares = 0
          let targetHitProbability = 0
          let companionProbability = 0
          let twoStepHitProbability = 0
          const outcomes = []
          const jointByOutcome = openingJointCounts.get(idx) ?? new Map()

          const bestSecondHitForOutcome = (slug, outcomeCount) => {
            if (outcomeCount <= 0) return 0
            const explicitJoint = jointByOutcome.get(slug) ?? new Map()
            let best = 0
            for (const [targetIdx, totalTargetCount] of targetPresenceCountsOpening) {
              if (targetIdx === idx || actuallyRevealedCells.has(targetIdx)) continue
              let jointCount
              if (slug === 'other') {
                let explicitTotal = 0
                for (const targetCounts of jointByOutcome.values()) {
                  explicitTotal += targetCounts.get(targetIdx) ?? 0
                }
                jointCount = Math.max(0, totalTargetCount - explicitTotal)
              } else {
                jointCount = explicitJoint.get(targetIdx) ?? 0
              }
              best = Math.max(best, jointCount / outcomeCount)
            }
            return best
          }

          for (const [slug, count] of counts) {
            const p = count / configurationCount
            sumKnown += p
            sumSquares += p * p
            if (slug === normalizedProbabilityTarget) {
              targetHitProbability = openingTargetProbabilities.get(idx) ?? p
              twoStepHitProbability += p
            } else {
              companionProbability += p
              twoStepHitProbability +=
                p * bestSecondHitForOutcome(slug, count)
            }
            outcomes.push({
              outcome: `treasure:${slug}`,
              probability: p,
              count,
            })
          }

          const otherCount = Math.max(0, configurationCount - sumKnown * configurationCount)
          const otherProbability = otherCount / configurationCount
          sumSquares += otherProbability * otherProbability
          if (otherProbability > 0) {
            twoStepHitProbability +=
              otherProbability * bestSecondHitForOutcome('other', otherCount)
            outcomes.push({
              outcome: 'other',
              probability: otherProbability,
              count: otherCount,
            })
          }

          outcomes.sort((a, b) =>
            b.probability - a.probability || a.outcome.localeCompare(b.outcome)
          )

          const targetInfoGain = 1 - sumSquares
          ranking.push({
            index: idx,
            targetAware: true,
            openingMode: true,
            adaptiveNext: true,
            probabilityBasis: 'target-pattern-configurations',
            openingConfigurationCount: configurationCount,
            targetInfoGain,
            targetHitProbability,
            configurationTargetHitProbability:
              counts.get(normalizedProbabilityTarget)
                ? (counts.get(normalizedProbabilityTarget) / configurationCount)
                : 0,
            twoStepHitProbability,
            adaptiveDepth: 2,
            expectedFoundFraction:
              twoStepHitProbability / Math.max(1, targetRemainingCount),
            expectedRemainingTargets: Math.max(
              0,
              targetRemainingCount - twoStepHitProbability,
            ),
            completionProbability:
              targetRemainingCount <= 1 ? twoStepHitProbability : 0,
            adaptiveScore: twoStepHitProbability,
            companionProbability,
            outcomes,
          })
        }

        if (deepTargetModel && openingLayoutCount > 0) {
          // v6 reduced target planner. This is still labelled approximate
          // because unrelated daily formations are not fully enumerated, but
          // within the target-bearing formations it uses equal-weight target
          // layouts and minimizes expected digs to completion.
          const byIndex = new Map(ranking.map(item => [item.index, item]))
          const allUnknown = []
          for (let idx = 0; idx < gridSize * gridSize; idx++) {
            if (!actuallyRevealedCells.has(idx)) allUnknown.push(idx)
          }

          const outcomeForRecord = (record, idx) => {
            const name = record.cells.get(idx)
            return name === undefined ? 'other' : `treasure:${slugify(name)}`
          }

          const weightedOutcomeStats = idx => {
            const buckets = new Map()
            let hit = 0
            for (let ri = 0; ri < openingRecords.length; ri++) {
              const weight = openingRecordWeights[ri] ?? 0
              if (weight <= 0) continue
              const outcome = outcomeForRecord(openingRecords[ri], idx)
              buckets.set(outcome, (buckets.get(outcome) ?? 0) + weight)
              if (
                openingRecords[ri].targetCells.includes(idx)
              ) hit += weight
            }
            let collision = 0
            for (const p of buckets.values()) collision += p * p
            return {
              hit,
              info: Math.max(0, 1 - collision),
              buckets,
            }
          }

          // Recompute direct probabilities and information on the SAME
          // equal-layout prior. Also add pure information cells that were not
          // explicit target-pattern treasure cells in the aggregate model.
          for (const idx of allUnknown) {
            const stats = weightedOutcomeStats(idx)
            if (stats.hit > 0) openingTargetProbabilities.set(idx, stats.hit)
            let item = byIndex.get(idx)
            if (!item) {
              item = {
                index: idx,
                targetAware: true,
                openingMode: true,
                adaptiveNext: true,
                openingConfigurationCount: configurationCount,
                companionProbability: 0,
                outcomes: [],
              }
              ranking.push(item)
              byIndex.set(idx, item)
            }
            item.probabilityBasis = 'unique-target-layouts-reduced'
            item.openingTargetLayoutCount = openingLayoutCount
            item.targetHitProbability = stats.hit
            item.targetInfoGain = stats.info
            item.configurationTargetHitProbability =
              openingRecords.length > 0
                ? openingRecords.filter(record =>
                    record.targetCells.includes(idx)
                  ).length / openingRecords.length
                : 0

            let companion = 0
            item.outcomes = [...stats.buckets.entries()]
              .map(([outcome, probability]) => {
                if (
                  outcome.startsWith('treasure:') &&
                  outcome !== `treasure:${normalizedProbabilityTarget}`
                ) companion += probability
                return {
                  outcome,
                  probability,
                  count: probability * openingRecords.length,
                }
              })
              .sort((a, b) =>
                b.probability - a.probability ||
                a.outcome.localeCompare(b.outcome)
              )
            item.companionProbability = companion
          }

          const searchDepth =
            openingLayoutCount > 1000 ? 2 :
              openingLayoutCount > 250 ? 3 :
                openingLayoutCount > 100 ? 4 :
                  openingLayoutCount > 20 ? 6 : 10

          // Keep direct targets and information probes in separate quotas so a
          // high-probability list cannot crowd every companion probe out.
          const directQuota =
            openingLayoutCount <= 20 ? 20 :
              openingLayoutCount <= 100 ? 12 : 10
          const infoQuota =
            openingLayoutCount <= 20 ? 12 :
              openingLayoutCount <= 100 ? 8 : 6

          const directCandidates = [...ranking]
            .filter(item => item.targetHitProbability > 0)
            .sort((a, b) =>
              b.targetHitProbability - a.targetHitProbability ||
              b.targetInfoGain - a.targetInfoGain ||
              a.index - b.index
            )
            .slice(0, directQuota)

          const infoCandidates = [...ranking]
            .sort((a, b) =>
              b.targetInfoGain - a.targetInfoGain ||
              b.targetHitProbability - a.targetHitProbability ||
              a.index - b.index
            )
            .slice(0, infoQuota)

          const recursivePool = []
          for (const item of [...directCandidates, ...infoCandidates]) {
            if (!recursivePool.includes(item.index)) recursivePool.push(item.index)
          }

          const initialRecords = Array.from(
            { length: openingRecords.length },
            (_, i) => i,
          )
          const stateWeightOpening = indexes => {
            let sum = 0
            for (const ri of indexes) sum += openingRecordWeights[ri] ?? 0
            return sum
          }
          const completeForOpeningRecord = (ri, dug) =>
            openingRecords[ri].targetCells.every(idx => dug.has(idx))

          const greedyRolloutCost = (recordIndexes, dug) => {
            const totalWeight = stateWeightOpening(recordIndexes)
            if (totalWeight <= 0) return 0

            const marginal = new Map()
            let allComplete = true
            for (const ri of recordIndexes) {
              const w = openingRecordWeights[ri] ?? 0
              for (const idx of openingRecords[ri].targetCells) {
                if (dug.has(idx)) continue
                allComplete = false
                marginal.set(idx, (marginal.get(idx) ?? 0) + w)
              }
            }
            if (allComplete) return 0

            const order = [...marginal.entries()]
              .sort((a, b) => b[1] - a[1] || a[0] - b[0])
              .map(([idx]) => idx)
            const rank = new Map(order.map((idx, i) => [idx, i + 1]))

            let expected = 0
            for (const ri of recordIndexes) {
              const normalized = (openingRecordWeights[ri] ?? 0) / totalWeight
              let finishAt = 0
              for (const idx of openingRecords[ri].targetCells) {
                if (dug.has(idx)) continue
                finishAt = Math.max(finishAt, rank.get(idx) ?? order.length)
              }
              expected += normalized * finishAt
            }
            return expected
          }

          let openingAdaptiveNodes = 0
          const OPENING_ADAPTIVE_NODE_CAP =
            openingLayoutCount <= 20 ? 100000 : 50000
          let openingLookaheadCapped = false
          const openingMemo = new Map()

          const openingStateKey = (recordIndexes, dug, depth) =>
            `${depth}|${recordIndexes.join(',')}|${[...dug].sort((a,b)=>a-b).join(',')}`

          const openingExpectedCost = (recordIndexes, dug, depth) => {
            const totalWeight = stateWeightOpening(recordIndexes)
            if (totalWeight <= 0) return 0

            let completeWeight = 0
            for (const ri of recordIndexes) {
              if (completeForOpeningRecord(ri, dug)) {
                completeWeight += openingRecordWeights[ri] ?? 0
              }
            }
            if (completeWeight >= totalWeight - 1e-12) return 0
            if (depth <= 0) return greedyRolloutCost(recordIndexes, dug)

            const key = openingStateKey(recordIndexes, dug, depth)
            if (openingMemo.has(key)) return openingMemo.get(key)

            openingAdaptiveNodes += 1
            if (openingAdaptiveNodes > OPENING_ADAPTIVE_NODE_CAP) {
              openingLookaheadCapped = true
              return greedyRolloutCost(recordIndexes, dug)
            }

            let best = greedyRolloutCost(recordIndexes, dug)
            for (const action of recursivePool) {
              if (dug.has(action)) continue
              const partitions = new Map()
              for (const ri of recordIndexes) {
                const outcome = outcomeForRecord(openingRecords[ri], action)
                if (!partitions.has(outcome)) partitions.set(outcome, [])
                partitions.get(outcome).push(ri)
              }
              const nextDug = new Set(dug)
              nextDug.add(action)
              let future = 0
              for (const branch of partitions.values()) {
                const p = stateWeightOpening(branch) / totalWeight
                if (p <= 0) continue
                future += p * openingExpectedCost(
                  branch,
                  nextDug,
                  depth - 1,
                )
              }
              best = Math.min(best, 1 + future)
            }
            openingMemo.set(key, best)
            return best
          }

          // For the "last target" endgame, evaluate EVERY unknown first move.
          // Subsequent recursion still uses the pruned balanced pool. This
          // prevents a 0%-hit information probe from winning unless it really
          // lowers expected completion cost.
          const firstActions =
            targetRemainingCount === 1 && openingLayoutCount <= 20
              ? allUnknown
              : [...new Set([...directCandidates, ...infoCandidates].map(x => x.index))]

          for (const idx of firstActions) {
            const item = byIndex.get(idx)
            if (!item) continue

            const partitions = new Map()
            for (const ri of initialRecords) {
              const outcome = outcomeForRecord(openingRecords[ri], idx)
              if (!partitions.has(outcome)) partitions.set(outcome, [])
              partitions.get(outcome).push(ri)
            }

            const dug = new Set([idx])
            let future = 0
            for (const branch of partitions.values()) {
              const p = stateWeightOpening(branch)
              if (p <= 0) continue
              future += p * openingExpectedCost(
                branch,
                dug,
                searchDepth - 1,
              )
            }

            item.expectedDigsToComplete = 1 + future
            item.adaptiveDepth = searchDepth
            item.lookaheadCapped = openingLookaheadCapped
            item.expectedRemainingTargets = Math.max(
              0,
              targetRemainingCount - item.targetHitProbability,
            )
            item.adaptiveScore = -item.expectedDigsToComplete
          }

          ranking.sort((a, b) =>
            (a.expectedDigsToComplete ?? Infinity) -
              (b.expectedDigsToComplete ?? Infinity) ||
            b.targetHitProbability - a.targetHitProbability ||
            b.targetInfoGain - a.targetInfoGain ||
            a.index - b.index
          )

          for (const item of ranking) {
            item.targetFeasibilityChecked = targetFeasibilityChecked
            item.targetFeasibilityRejected = targetFeasibilityRejected
            item.targetFeasibilityCapped = targetFeasibilityCapped
          }

          const bestDirectOpening = [...ranking]
            .filter(item => item.targetHitProbability > 0)
            .sort((a, b) =>
              b.targetHitProbability - a.targetHitProbability ||
              (a.expectedDigsToComplete ?? Infinity) -
                (b.expectedDigsToComplete ?? Infinity) ||
              a.index - b.index
            )[0] ?? null

          // v8 robustness guard: expected-cost differences in the reduced
          // model are estimates, not proof. Do not give up a much stronger
          // direct hit for a tiny modelled gain. The noisier the state, the
          // larger the gain an information probe must prove before it wins.
          const approximateCostMargin =
            targetFeasibilityCapped || openingLookaheadCapped ? 1.00 :
              openingLayoutCount > 1000 ? 0.75 :
                openingLayoutCount > 250 ? 0.65 :
                  openingLayoutCount > 100 ? 0.50 :
                    openingLayoutCount > 20 ? 0.35 : 0.15

          const modelPreferredOpening = ranking[0] ?? null
          if (
            modelPreferredOpening &&
            bestDirectOpening &&
            modelPreferredOpening.index !== bestDirectOpening.index &&
            Number.isFinite(modelPreferredOpening.expectedDigsToComplete) &&
            Number.isFinite(bestDirectOpening.expectedDigsToComplete)
          ) {
            const modelAdvantage =
              bestDirectOpening.expectedDigsToComplete -
              modelPreferredOpening.expectedDigsToComplete

            modelPreferredOpening.robustCostMargin = approximateCostMargin
            modelPreferredOpening.robustCostAdvantage = modelAdvantage

            if (modelAdvantage < approximateCostMargin - 1e-12) {
              bestDirectOpening.robustFallbackUsed = true
              bestDirectOpening.robustReason = 'approximate-cost-margin'
              bestDirectOpening.robustCostMargin = approximateCostMargin
              bestDirectOpening.robustCostAdvantage = modelAdvantage
              bestDirectOpening.modelPreferredIndex = modelPreferredOpening.index
              bestDirectOpening.modelPreferredProbability =
                modelPreferredOpening.targetHitProbability
              bestDirectOpening.modelPreferredExpectedDigs =
                modelPreferredOpening.expectedDigsToComplete

              const directPosition = ranking.indexOf(bestDirectOpening)
              if (directPosition > 0) {
                ranking.splice(directPosition, 1)
                ranking.unshift(bestDirectOpening)
              }
            }
          }

          if (ranking[0] && bestDirectOpening) {
            ranking[0].bestDirectAlternativeIndex = bestDirectOpening.index
            ranking[0].bestDirectAlternativeProbability =
              bestDirectOpening.targetHitProbability
            ranking[0].bestDirectAlternativeExpectedDigs =
              Number.isFinite(bestDirectOpening.expectedDigsToComplete)
                ? bestDirectOpening.expectedDigsToComplete
                : null
          }

          return {
            configurationCount,
            targetLayoutCount: openingLayoutCount,
            targetFeasibilityChecked,
            targetFeasibilityRejected,
            targetFeasibilityCapped,
            targetProbabilities: openingTargetProbabilities,
            ranking,
            best: ranking[0] ?? null,
          }
        }

        for (const item of ranking) {
          item.targetFeasibilityChecked = targetFeasibilityChecked
          item.targetFeasibilityRejected = targetFeasibilityRejected
          item.targetFeasibilityCapped = targetFeasibilityCapped
        }

        ranking.sort((a, b) => {
          // NEXT optimizes the chance of finding the selected target within
          // the next TWO adaptive digs. This automatically balances a direct
          // hit now against an informative first dig that creates a much
          // stronger second move. Re-run after every real result.
          const aGuaranteed = a.targetHitProbability >= 1 - 1e-12
          const bGuaranteed = b.targetHitProbability >= 1 - 1e-12
          if (aGuaranteed !== bGuaranteed) return aGuaranteed ? -1 : 1
          return (
            b.twoStepHitProbability - a.twoStepHitProbability ||
            b.targetHitProbability - a.targetHitProbability ||
            b.targetInfoGain - a.targetInfoGain ||
            b.companionProbability - a.companionProbability ||
            a.index - b.index
          )
        })

        return {
          configurationCount,
          targetLayoutCount: openingLayoutCount,
          targetFeasibilityChecked,
          targetFeasibilityRejected,
          targetFeasibilityCapped,
          targetProbabilities: openingTargetProbabilities,
          ranking,
          best: ranking[0] ?? null,
        }
      }

      const occupied = new Set()
      const chosen = []
      let probabilityNodes = 0
      let probabilityAborted = false

      // Confirmed instances are fixed ground truth and cannot be overlapped.
      for (const idx of fixedProbabilityCells) occupied.add(idx)

      const allRevealsCovered = () => {
        for (const idx of revealedTreasureName.keys()) {
          if (!occupied.has(idx)) return false
        }
        return true
      }

      // Every revealed crab must border at least one treasure in the completed
      // board. This is a real game invariant, so it is valid for probabilities
      // even though Pass 5 intentionally omits it for conservative naming.
      const crabsSatisfied = () => {
        for (const idx of revealedCrab) {
          const x = idx % gridSize
          const y = Math.floor(idx / gridSize)
          let adjacent = false
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx
            const ny = y + dy
            if (inBounds(nx, ny) && occupied.has(ny * gridSize + nx)) {
              adjacent = true
              break
            }
          }
          if (!adjacent) return false
        }
        return true
      }

      const abortProbabilitySearch = () => {
        probabilityComplete = false
        probabilityReason = 'too-complex'
        probabilityAborted = true
      }

      const recordProbabilitySolution = () => {
        globalSolutionCount += 1

        // We intentionally search one solution beyond the cap. That lets a
        // board with EXACTLY N solutions remain exact when cap=N, while N+1
        // proves the search is too broad and must not expose biased prefixes.
        if (globalSolutionCount > probabilitySolutionCap) {
          abortProbabilitySearch()
          return
        }

        // Include both confirmed and still-chosen instances. The UI hides
        // already-revealed cells, but an undug cell in a confirmed formation
        // should correctly show 100%.
        const cellsInSolution = new Map()
        for (const plots of [...confirmedPlacements, ...chosen]) {
          for (const [idx, name] of plots) cellsInSolution.set(idx, name)
        }

        // Target-layout signature contains only still-undug cells of the
        // selected treasure. Different bottle/clam/etc. layouts with the same
        // target signature are intentionally treated as the same target state.
        const targetCells = []
        if (normalizedProbabilityTarget) {
          for (const [idx, name] of cellsInSolution) {
            if (
              !actuallyRevealedCells.has(idx) &&
              slugify(name) === normalizedProbabilityTarget
            ) {
              targetCells.push(idx)
            }
          }
        }
        targetCells.sort((a, b) => a - b)
        const targetSignature = targetCells.join(',')
        if (normalizedProbabilityTarget) {
          targetSolutionCells.push(targetCells)
          targetSignatureCounts.set(
            targetSignature,
            (targetSignatureCounts.get(targetSignature) ?? 0) + 1,
          )
        }

        for (const [idx, name] of cellsInSolution) {
          const slug = slugify(name)
          let byName = probabilityCounts.get(idx)
          if (!byName) {
            byName = new Map()
            probabilityCounts.set(idx, byName)
          }
          byName.set(slug, (byName.get(slug) ?? 0) + 1)
        }

        // Record the observable result of digging every still-hidden cell for
        // this complete board. In the game, every non-treasure cell adjacent
        // orthogonally to a treasure is a Crab; all other cells are Sand.
        // These partitions let us choose the next dig that, on average, rules
        // out the largest number of still-valid board configurations.
        const totalCells = gridSize * gridSize
        for (let idx = 0; idx < totalCells; idx++) {
          if (actuallyRevealedCells.has(idx)) continue

          let outcome
          const treasureName = cellsInSolution.get(idx)
          if (treasureName !== undefined) {
            outcome = `treasure:${slugify(treasureName)}`
          } else {
            const x = idx % gridSize
            const y = Math.floor(idx / gridSize)
            let nextToTreasure = false
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx
              const ny = y + dy
              if (!inBounds(nx, ny)) continue
              if (cellsInSolution.has(ny * gridSize + nx)) {
                nextToTreasure = true
                break
              }
            }
            outcome = nextToTreasure ? 'crab' : 'sand'
          }

          let counts = outcomeCounts.get(idx)
          if (!counts) {
            counts = new Map()
            outcomeCounts.set(idx, counts)
          }
          counts.set(outcome, (counts.get(outcome) ?? 0) + 1)

          if (normalizedProbabilityTarget) {
            let byOutcome = targetJointCounts.get(idx)
            if (!byOutcome) {
              byOutcome = new Map()
              targetJointCounts.set(idx, byOutcome)
            }
            let bySignature = byOutcome.get(outcome)
            if (!bySignature) {
              bySignature = new Map()
              byOutcome.set(outcome, bySignature)
            }
            bySignature.set(
              targetSignature,
              (bySignature.get(targetSignature) ?? 0) + 1,
            )
          }
        }

        // Compact per-solution outcome vector for adaptive v4 lookahead.
        // 1=sand, 2=crab, 3+=specific treasure. This preserves correlations
        // between outcomes at different cells without keeping 100 strings per
        // solution (~2 MB at the 20k-solution cap).
        const encoded = new Uint8Array(totalCells)
        for (let idx = 0; idx < totalCells; idx++) {
          let outcomeName
          const treasureName = cellsInSolution.get(idx)
          if (treasureName !== undefined) {
            outcomeName = `treasure:${slugify(treasureName)}`
          } else {
            const x = idx % gridSize
            const y = Math.floor(idx / gridSize)
            let nextToTreasure = false
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx
              const ny = y + dy
              if (inBounds(nx, ny) && cellsInSolution.has(ny * gridSize + nx)) {
                nextToTreasure = true
                break
              }
            }
            outcomeName = nextToTreasure ? 'crab' : 'sand'
          }
          let code = outcomeCodeByName.get(outcomeName)
          if (!code) {
            code = nextOutcomeCode++
            // Uint8Array safely supports today's tiny outcome vocabulary.
            if (code > 255) code = 255
            outcomeCodeByName.set(outcomeName, code)
          }
          encoded[idx] = code
        }
        solutionOutcomeCodes.push(encoded)
      }

      const revealEntries = [...revealedTreasureName]
      const crabNeighbours = [...revealedCrab].map(idx => {
        const x = idx % gridSize
        const y = Math.floor(idx / gridSize)
        return [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => [x + dx, y + dy])
          .filter(([nx, ny]) => inBounds(nx, ny))
          .map(([nx, ny]) => ny * gridSize + nx)
      })

      const placementFitsOccupied = plots =>
        ![...plots.keys()].some(idx => occupied.has(idx))

      // Necessary-condition pruning: every uncovered revealed treasure and
      // unsatisfied crab must still be explainable by at least one placement
      // that remains selectable from the current DFS state.
      const anyRemainingPlacement = (groupIndex, startPlacement, left, predicate) => {
        for (let gi = groupIndex; gi < probabilityGroups.length; gi++) {
          const group = probabilityGroups[gi]
          const from = gi === groupIndex && left > 0 ? startPlacement : 0
          if (gi === groupIndex && left === 0) continue
          for (let pi = from; pi < group.placements.length; pi++) {
            const plots = group.placements[pi]
            if (!placementFitsOccupied(plots)) continue
            if (predicate(plots)) return true
          }
        }
        return false
      }

      const remainingConstraintsFeasible = (groupIndex, startPlacement, left) => {
        for (const [idx, name] of revealEntries) {
          if (occupied.has(idx)) continue
          const canCover = anyRemainingPlacement(
            groupIndex,
            startPlacement,
            left,
            plots => namesMatch(plots.get(idx), name),
          )
          if (!canCover) return false
        }

        for (const neighbours of crabNeighbours) {
          if (neighbours.some(idx => occupied.has(idx))) continue
          const canSatisfy = anyRemainingPlacement(
            groupIndex,
            startPlacement,
            left,
            plots => neighbours.some(idx => plots.has(idx)),
          )
          if (!canSatisfy) return false
        }
        return true
      }

      // Pick combinations (not permutations) for duplicate instances of a
      // single shape key. Different keys remain distinct daily formation
      // instances, matching the solver's existing global-consistency model.
      const chooseFromGroup = (groupIndex, startPlacement, left) => {
        if (probabilityAborted) return
        probabilityNodes += 1
        if (probabilityNodes > probabilityNodeCap) {
          abortProbabilitySearch()
          return
        }

        if (groupIndex >= probabilityGroups.length) {
          if (allRevealsCovered() && crabsSatisfied()) recordProbabilitySolution()
          return
        }

        if (!remainingConstraintsFeasible(groupIndex, startPlacement, left)) return

        const group = probabilityGroups[groupIndex]
        if (left === 0) {
          chooseFromGroup(
            groupIndex + 1,
            0,
            probabilityGroups[groupIndex + 1]?.need ?? 0,
          )
          return
        }

        for (let pi = startPlacement; pi < group.placements.length; pi++) {
          if (probabilityAborted) return
          const plots = group.placements[pi]
          const keys = [...plots.keys()]
          if (keys.some(idx => occupied.has(idx))) continue

          for (const idx of keys) occupied.add(idx)
          chosen.push(plots)
          chooseFromGroup(groupIndex, pi + 1, left - 1)
          chosen.pop()
          for (const idx of keys) occupied.delete(idx)
        }
      }

      if (probabilityGroups.length) {
        chooseFromGroup(0, 0, probabilityGroups[0].need)
      } else if (allRevealsCovered() && crabsSatisfied()) {
        // Everything is already confirmed: one exact board remains.
        recordProbabilitySolution()
      }

      if (probabilityComplete && globalSolutionCount === 0) {
        probabilityComplete = false
        probabilityReason = 'inconsistent'
      }

      if (probabilityComplete && globalSolutionCount > 0) {
        probabilities = new Map()
        for (const [idx, counts] of probabilityCounts) {
          const byName = new Map()
          for (const [slug, count] of counts) {
            byName.set(slug, count / globalSolutionCount)
          }
          probabilities.set(idx, byName)
        }
        probabilityMode = 'exact'
        targetLayoutCount = targetSignatureCounts.size

        // For the selected target, also expose a target-layout-normalized
        // probability. Every DISTINCT target layout gets equal weight, so
        // unrelated patterns cannot inflate a cell merely because that target
        // layout combines with many Bottle/Seaweed/etc. completions.
        targetProbabilities = new Map()
        if (normalizedProbabilityTarget && targetSignatureCounts.size > 0) {
          const uniqueSignatures = [...targetSignatureCounts.keys()]
          for (const signature of uniqueSignatures) {
            if (!signature) continue
            for (const token of signature.split(',')) {
              const idx = Number(token)
              if (!Number.isFinite(idx)) continue
              targetProbabilities.set(
                idx,
                (targetProbabilities.get(idx) ?? 0) + 1 / uniqueSignatures.length,
              )
            }
          }
        }

        // Exact 3-dig target plan over DISTINCT target layouts.
        // This must use the same distribution as the selected-target percentages
        // shown in the UI. Otherwise unrelated formation multiplicity can make
        // the plan disagree with Top 10 (e.g. Top 10 says 24% while P1 says 32%).
        targetPlan = null
        if (normalizedProbabilityTarget && targetSignatureCounts.size > 0) {
          const uniqueLayouts = [...targetSignatureCounts.keys()].map(signature =>
            signature
              ? signature.split(',').map(Number).filter(Number.isFinite)
              : []
          )
          const candidates = [...targetProbabilities.entries()]
            .filter(([idx, p]) => !actuallyRevealedCells.has(idx) && p > 0)
            .map(([idx, p]) => ({ idx, p }))
            .sort((a, b) => b.p - a.p || a.idx - b.idx)

          // Keep a wider complementary pool, but evaluate every combination
          // against the same equal-weight unique-target-layout distribution.
          const pool = candidates.slice(0, 30)
          const words = Math.ceil(uniqueLayouts.length / 32)
          const bitsets = new Map(
            pool.map(({ idx }) => [idx, new Uint32Array(words)])
          )
          const poolSet = new Set(pool.map(({ idx }) => idx))

          for (let li = 0; li < uniqueLayouts.length; li++) {
            const word = li >>> 5
            const bit = (1 << (li & 31)) >>> 0
            for (const idx of uniqueLayouts[li]) {
              if (!poolSet.has(idx)) continue
              bitsets.get(idx)[word] |= bit
            }
          }

          const popcount32 = value => {
            let v = value >>> 0
            v = v - ((v >>> 1) & 0x55555555)
            v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
            return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24
          }

          const unionCount = indexes => {
            let count = 0
            for (let wi = 0; wi < words; wi++) {
              let value = 0
              for (const idx of indexes) value |= bitsets.get(idx)[wi]
              count += popcount32(value)
            }
            return count
          }

          let bestCombo = []
          let bestCount = 0
          const n = pool.length

          for (let i = 0; i < n; i++) {
            const combo = [pool[i].idx]
            const count = unionCount(combo)
            if (count > bestCount) {
              bestCount = count
              bestCombo = combo
            }
          }

          if (n >= 2) {
            bestCount = -1
            for (let i = 0; i < n - 1; i++) {
              for (let j = i + 1; j < n; j++) {
                const combo = [pool[i].idx, pool[j].idx]
                const count = unionCount(combo)
                if (count > bestCount) {
                  bestCount = count
                  bestCombo = combo
                }
              }
            }
          }

          if (n >= 3) {
            bestCount = -1
            for (let i = 0; i < n - 2; i++) {
              for (let j = i + 1; j < n - 1; j++) {
                for (let k = j + 1; k < n; k++) {
                  const combo = [pool[i].idx, pool[j].idx, pool[k].idx]
                  const count = unionCount(combo)
                  if (count > bestCount) {
                    bestCount = count
                    bestCombo = combo
                  }
                }
              }
            }
          }

          if (bestCombo.length) {
            const remaining = [...bestCombo]
            const ordered = []
            while (remaining.length) {
              let bestIdx = remaining[0]
              let bestUnion = -1
              for (const idx of remaining) {
                const count = unionCount([...ordered, idx])
                if (count > bestUnion) {
                  bestUnion = count
                  bestIdx = idx
                }
              }
              ordered.push(bestIdx)
              remaining.splice(remaining.indexOf(bestIdx), 1)
            }

            const denominator = uniqueLayouts.length
            const steps = []
            for (let i = 0; i < ordered.length; i++) {
              const prefix = ordered.slice(0, i + 1)
              const hits = unionCount(prefix)
              const cumulativeProbability = hits / denominator
              const prevHits = i === 0 ? 0 : unionCount(prefix.slice(0, -1))
              const remainingBeforeStep = denominator - prevHits
              const conditionalProbability = remainingBeforeStep > 0
                ? (hits - prevHits) / remainingBeforeStep
                : 0

              steps.push({
                step: i + 1,
                index: ordered[i],
                directProbability: targetProbabilities.get(ordered[i]) ?? 0,
                cumulativeProbability,
                marginalProbability: (hits - prevHits) / denominator,
                conditionalProbability,
              })

              if (cumulativeProbability >= 1 - 1e-12) break
            }

            targetPlan = {
              target: normalizedProbabilityTarget,
              horizon: steps.length,
              candidatePoolSize: pool.length,
              exact: true,
              basis: 'unique-target-layouts',
              steps,
              cumulativeProbability:
                steps[steps.length - 1]?.cumulativeProbability ?? 0,
            }
          }
        }

        smartDigRanking = []

        if (normalizedProbabilityTarget && targetSignatureCounts.size === 1 && !targetComplete) {
          // The target layout is fully determined. BEST must point at the
          // guaranteed target itself; falling back to whole-board entropy would
          // recommend unrelated Bottle/Starfish/etc. cells.
          const exactTargetCells = [...targetProbabilities.entries()]
            .filter(([idx, p]) =>
              !actuallyRevealedCells.has(idx) &&
              p >= 1 - 1e-12
            )
            .map(([idx]) => idx)
            .sort((a, b) => a - b)

          smartDigRanking = exactTargetCells.map(idx => ({
            index: idx,
            targetInfoGain: 1,
            targetHitProbability: 1,
            worstCaseTargetGain: 1,
            expectedTargetImpurity: 0,
            outcomes: [{
              outcome: `treasure:${normalizedProbabilityTarget}`,
              probability: 1,
              count: globalSolutionCount,
              targetPosteriorImpurity: 0,
            }],
            targetAware: true,
            targetLocked: true,
            adaptiveNext: true,
            adaptiveDepth: 1,
            adaptiveScore: -Math.max(1, targetRemainingCount),
            expectedDigsToComplete: Math.max(1, targetRemainingCount),
            expectedFoundFraction: 1 / Math.max(1, targetRemainingCount),
            expectedRemainingTargets: Math.max(0, targetRemainingCount - 1),
            completionProbability: targetRemainingCount <= 1 ? 1 : 0,
            twoStepHitProbability: 1,
          }))
        } else if (normalizedProbabilityTarget && targetSignatureCounts.size > 1) {
          // Target-aware information gain with an EQUAL prior over distinct
          // target layouts. The previous implementation weighted a target
          // layout once per compatible full-board completion, so uncertainty
          // in Bottle/Cockle/etc. could distort both BEST and its reported hit
          // chance. Here each target layout has prior 1/L; full-board solutions
          // are used only to estimate P(observed outcome | target layout).
          const signatures = [...targetSignatureCounts.keys()]
          const layoutCount = signatures.length
          const baselineImpurity = 1 - (1 / layoutCount)

          for (const [idx, byOutcome] of targetJointCounts) {
            if (actuallyRevealedCells.has(idx)) continue

            let expectedPosteriorImpurity = 0
            let targetHitProbability = 0
            let worstPosteriorImpurity = 0
            const outcomes = []

            for (const [outcome, bySignature] of byOutcome) {
              const likelihoods = []
              let likelihoodSum = 0

              for (const signature of signatures) {
                const layoutSolutions = targetSignatureCounts.get(signature) ?? 0
                if (layoutSolutions <= 0) continue
                const matchingSolutions = bySignature.get(signature) ?? 0
                const likelihood = matchingSolutions / layoutSolutions
                if (likelihood <= 0) continue
                likelihoods.push([signature, likelihood])
                likelihoodSum += likelihood
              }

              if (likelihoodSum <= 0) continue

              const pOutcome = likelihoodSum / layoutCount
              let posteriorCollision = 0
              for (const [, likelihood] of likelihoods) {
                const posterior = likelihood / likelihoodSum
                posteriorCollision += posterior * posterior
              }

              const posteriorImpurity = 1 - posteriorCollision
              expectedPosteriorImpurity += pOutcome * posteriorImpurity
              worstPosteriorImpurity = Math.max(
                worstPosteriorImpurity,
                posteriorImpurity,
              )

              if (outcome === `treasure:${normalizedProbabilityTarget}`) {
                targetHitProbability += pOutcome
              }

              outcomes.push({
                outcome,
                probability: pOutcome,
                count: pOutcome * globalSolutionCount,
                targetPosteriorImpurity: posteriorImpurity,
              })
            }

            outcomes.sort((a, b) =>
              b.probability - a.probability || a.outcome.localeCompare(b.outcome)
            )

            const rawTargetGain = Math.max(
              0,
              baselineImpurity - expectedPosteriorImpurity,
            )
            const targetInfoGain = baselineImpurity > 0
              ? rawTargetGain / baselineImpurity
              : 0
            const worstCaseTargetGain = baselineImpurity > 0
              ? Math.max(0, baselineImpurity - worstPosteriorImpurity) / baselineImpurity
              : 0

            smartDigRanking.push({
              index: idx,
              targetInfoGain,
              targetHitProbability,
              worstCaseTargetGain,
              expectedTargetImpurity: expectedPosteriorImpurity,
              outcomes,
              targetAware: true,
              probabilityBasis: 'unique-target-layouts',
            })
          }

          // Adaptive v5: minimize EXPECTED DIGS TO COMPLETION.
          //
          // v4 maximized progress/completion inside a fixed horizon. That can
          // prefer a pure information probe over a 50/50 direct target even
          // when the latter has a lower expected number of digs. v5 assigns
          // every candidate an expected remaining dig cost:
          //
          //   cost(action) = 1 + Σ P(outcome) * bestCost(nextState)
          //
          // The exact search is bounded and uses a conservative leaf estimate
          // when the horizon/node budget is exhausted.
          const adaptiveDepth =
            layoutCount > 10000 ? 2 :
              layoutCount > 1000 ? 3 :
                layoutCount > 100 ? 4 :
                  layoutCount > 20 ? 6 : 8

          const adaptivePoolSize =
            adaptiveDepth <= 2 ? 14 :
              adaptiveDepth === 3 ? 10 :
                adaptiveDepth === 4 ? 8 :
                  adaptiveDepth === 6 ? 8 : 10

          // Equal prior over UNIQUE target layouts. Multiple compatible
          // full-board completions of the same target layout split its weight.
          const solutionWeights = targetSolutionCells.map(cells => {
            const signature = cells.join(',')
            const multiplicity = targetSignatureCounts.get(signature) ?? 1
            return 1 / (layoutCount * multiplicity)
          })

          const candidateIndexes = []
          const addCandidate = idx => {
            if (
              Number.isFinite(idx) &&
              !actuallyRevealedCells.has(idx) &&
              !candidateIndexes.includes(idx)
            ) candidateIndexes.push(idx)
          }

          // v6 keeps dedicated capacity for BOTH direct target cells and
          // information probes. v5 could fill the whole pool with target cells
          // before a strong companion/Crab/Sand probe was even considered.
          const directQuota = Math.max(
            1,
            Math.ceil(adaptivePoolSize * 0.65),
          )
          const infoQuota = Math.max(1, adaptivePoolSize - directQuota)

          ;[...targetProbabilities.entries()]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, directQuota)
            .forEach(([idx]) => addCandidate(idx))

          ;[...smartDigRanking]
            .sort((a, b) =>
              b.targetInfoGain - a.targetInfoGain ||
              b.targetHitProbability - a.targetHitProbability ||
              a.index - b.index
            )
            .slice(0, infoQuota)
            .forEach(item => addCandidate(item.index))

          // If direct/info lists overlap, fill the spare slots with the next
          // best candidates from either list.
          ;[
            ...[...targetProbabilities.entries()]
              .sort((a, b) => b[1] - a[1] || a[0] - b[0])
              .map(([idx]) => idx),
            ...[...smartDigRanking]
              .sort((a, b) =>
                b.targetInfoGain - a.targetInfoGain ||
                b.targetHitProbability - a.targetHitProbability ||
                a.index - b.index
              )
              .map(item => item.index),
          ].forEach(idx => {
            if (candidateIndexes.length < adaptivePoolSize) addCandidate(idx)
          })

          const pool = candidateIndexes.slice(0, adaptivePoolSize)
          const initialSolutions = Array.from(
            { length: targetSolutionCells.length },
            (_, i) => i,
          )

          let adaptiveNodes = 0
          const ADAPTIVE_NODE_CAP = 75000
          let adaptiveCapped = false
          const memo = new Map()

          const stateWeight = solutionIndexes => {
            let sum = 0
            for (const si of solutionIndexes) sum += solutionWeights[si] ?? 0
            return sum
          }

          const isCompleteForSolution = (si, dug) => {
            for (const idx of targetSolutionCells[si] || []) {
              if (!dug.has(idx)) return false
            }
            return true
          }

          const completionProbabilityForState = (solutionIndexes, dug) => {
            const totalWeight = stateWeight(solutionIndexes)
            if (totalWeight <= 0) return 1
            let done = 0
            for (const si of solutionIndexes) {
              if (isCompleteForSolution(si, dug)) {
                done += solutionWeights[si] ?? 0
              }
            }
            return done / totalWeight
          }

          const expectedMissingTargets = (solutionIndexes, dug) => {
            const totalWeight = stateWeight(solutionIndexes)
            if (totalWeight <= 0) return 0
            let expected = 0
            for (const si of solutionIndexes) {
              let missing = 0
              for (const idx of targetSolutionCells[si] || []) {
                if (!dug.has(idx)) missing += 1
              }
              expected += ((solutionWeights[si] ?? 0) / totalWeight) * missing
            }
            return expected
          }

          // v6 leaf value = a concrete greedy rollout, not an arbitrary
          // ambiguity penalty. Order remaining target cells by posterior
          // marginal probability, then measure when each compatible solution
          // would be completed under that fixed policy. This is a real
          // achievable continuation cost and therefore a useful upper bound.
          const leafExpectedCost = (solutionIndexes, dug) => {
            const totalWeight = stateWeight(solutionIndexes)
            if (totalWeight <= 0) return 0

            const marginal = new Map()
            let anyMissing = false
            for (const si of solutionIndexes) {
              const w = solutionWeights[si] ?? 0
              for (const idx of targetSolutionCells[si] || []) {
                if (dug.has(idx)) continue
                anyMissing = true
                marginal.set(idx, (marginal.get(idx) ?? 0) + w)
              }
            }
            if (!anyMissing) return 0

            const order = [...marginal.entries()]
              .sort((a, b) => b[1] - a[1] || a[0] - b[0])
              .map(([idx]) => idx)
            const rank = new Map(order.map((idx, i) => [idx, i + 1]))

            let expected = 0
            for (const si of solutionIndexes) {
              const normalized = (solutionWeights[si] ?? 0) / totalWeight
              let finishAt = 0
              for (const idx of targetSolutionCells[si] || []) {
                if (dug.has(idx)) continue
                finishAt = Math.max(finishAt, rank.get(idx) ?? order.length)
              }
              expected += normalized * finishAt
            }
            return expected
          }

          const keyForState = (solutionIndexes, dug, depth) =>
            `${depth}|${solutionIndexes.join(',')}|${[...dug].sort((a,b)=>a-b).join(',')}`

          const evaluateCost = (solutionIndexes, dug, depth) => {
            const completion = completionProbabilityForState(solutionIndexes, dug)
            if (completion >= 1 - 1e-12) return 0
            if (depth <= 0 || !solutionIndexes.length) {
              return leafExpectedCost(solutionIndexes, dug)
            }

            const key = keyForState(solutionIndexes, dug, depth)
            if (memo.has(key)) return memo.get(key)

            adaptiveNodes += 1
            if (adaptiveNodes > ADAPTIVE_NODE_CAP) {
              adaptiveCapped = true
              return leafExpectedCost(solutionIndexes, dug)
            }

            const totalWeight = stateWeight(solutionIndexes)
            if (totalWeight <= 0) return 0

            let bestCost = Infinity
            for (const action of pool) {
              if (dug.has(action)) continue

              const partitions = new Map()
              for (const si of solutionIndexes) {
                const code = solutionOutcomeCodes[si]?.[action] ?? 0
                if (!partitions.has(code)) partitions.set(code, [])
                partitions.get(code).push(si)
              }

              const nextDug = new Set(dug)
              nextDug.add(action)
              let expectedFuture = 0

              for (const branchSolutions of partitions.values()) {
                const branchWeight = stateWeight(branchSolutions)
                if (branchWeight <= 0) continue
                const p = branchWeight / totalWeight
                expectedFuture += p * evaluateCost(
                  branchSolutions,
                  nextDug,
                  depth - 1,
                )
              }

              const cost = 1 + expectedFuture
              if (cost < bestCost) bestCost = cost
            }

            if (!Number.isFinite(bestCost)) {
              bestCost = leafExpectedCost(solutionIndexes, dug)
            }
            memo.set(key, bestCost)
            return bestCost
          }

          const exactFirstActionSet =
            targetRemainingCount === 1 && layoutCount <= 20
              ? new Set(
                  smartDigRanking
                    .filter(item => !actuallyRevealedCells.has(item.index))
                    .map(item => item.index),
                )
              : new Set(pool)

          for (const candidate of smartDigRanking) {
            const firstIdx = candidate.index
            candidate.adaptiveNext = true
            candidate.adaptiveDepth = adaptiveDepth

            if (!exactFirstActionSet.has(firstIdx)) {
              candidate.expectedDigsToComplete = Infinity
              candidate.expectedRemainingTargets = targetRemainingCount
              candidate.completionProbability = 0
              candidate.lookaheadCapped = adaptiveCapped
              continue
            }

            const partitions = new Map()
            for (const si of initialSolutions) {
              const code = solutionOutcomeCodes[si]?.[firstIdx] ?? 0
              if (!partitions.has(code)) partitions.set(code, [])
              partitions.get(code).push(si)
            }

            const dug = new Set([firstIdx])
            let expectedFuture = 0
            let completionProbability = 0
            let expectedRemainingTargets = 0

            for (const branchSolutions of partitions.values()) {
              const branchWeight = stateWeight(branchSolutions)
              if (branchWeight <= 0) continue
              const p = branchWeight // global solution weights sum to 1

              expectedFuture += p * evaluateCost(
                branchSolutions,
                dug,
                adaptiveDepth - 1,
              )

              completionProbability +=
                p * completionProbabilityForState(branchSolutions, dug)
              expectedRemainingTargets +=
                p * expectedMissingTargets(branchSolutions, dug)
            }

            candidate.expectedDigsToComplete = 1 + expectedFuture
            candidate.expectedRemainingTargets = expectedRemainingTargets
            candidate.completionProbability = completionProbability
            candidate.expectedFoundFraction = targetRemainingCount > 0
              ? Math.max(
                  0,
                  1 - (expectedRemainingTargets / targetRemainingCount),
                )
              : 1
            candidate.adaptiveScore = -candidate.expectedDigsToComplete
            candidate.lookaheadCapped = adaptiveCapped
          }

          // v7 exact last-target endgame.
          //
          // With one target left and a small number of target layouts, solve
          // the decision problem to completion instead of using a depth/node
          // capped horizon. A state is fully described by the still-compatible
          // full solutions; past non-target digs need not be memoized because
          // their observed information is already encoded by that subset.
          //
          // Useless actions (same posterior state, no target hit) are skipped,
          // and actions that induce the same posterior partition are evaluated
          // only once per state. This makes the 4-layout style endgames from
          // real logs tiny and gives a proof-quality expected dig count.
          const optimalSolutionCap =
            layoutCount <= 4 ? 2500 :
              layoutCount <= 8 ? 1200 : 750
          const useOptimalEndgame =
            targetRemainingCount === 1 &&
            layoutCount <= 12 &&
            globalSolutionCount <= optimalSolutionCap

          if (useOptimalEndgame) {
            const targetOutcomeCode =
              outcomeCodeByName.get(`treasure:${normalizedProbabilityTarget}`)
            const allActions = smartDigRanking
              .map(item => item.index)
              .filter(idx => !actuallyRevealedCells.has(idx))
              .sort((a, b) => a - b)
            const optimalMemo = new Map()
            let optimalStates = 0

            const posteriorWeight = indexes => {
              let sum = 0
              for (const si of indexes) sum += solutionWeights[si] ?? 0
              return sum
            }

            const directRolloutCost = indexes => {
              const total = posteriorWeight(indexes)
              if (total <= 0) return 0
              const targetMass = new Map()
              for (const si of indexes) {
                const targetIdx = targetSolutionCells[si]?.[0]
                if (!Number.isFinite(targetIdx)) continue
                targetMass.set(
                  targetIdx,
                  (targetMass.get(targetIdx) ?? 0) +
                    (solutionWeights[si] ?? 0),
                )
              }
              const order = [...targetMass.entries()]
                .sort((a, b) => b[1] - a[1] || a[0] - b[0])
              let expected = 0
              for (let i = 0; i < order.length; i++) {
                expected += (order[i][1] / total) * (i + 1)
              }
              return expected
            }

            const partitionForAction = (indexes, action) => {
              const groups = new Map()
              for (const si of indexes) {
                const code = solutionOutcomeCodes[si]?.[action] ?? 0
                if (!groups.has(code)) groups.set(code, [])
                groups.get(code).push(si)
              }
              return groups
            }

            const optimalCost = indexes => {
              if (!indexes.length) return 0
              const key = indexes.join(',')
              if (optimalMemo.has(key)) return optimalMemo.get(key)
              optimalStates += 1

              let best = directRolloutCost(indexes)
              const total = posteriorWeight(indexes)
              if (total <= 0 || best <= 1 + 1e-12) {
                optimalMemo.set(key, best)
                return best
              }

              const seenPartitions = new Set()
              for (const action of allActions) {
                const groups = partitionForAction(indexes, action)
                const targetBranch = targetOutcomeCode == null
                  ? null
                  : groups.get(targetOutcomeCode)
                const targetMass = targetBranch
                  ? posteriorWeight(targetBranch)
                  : 0

                // One unchanged non-target bucket and no possible hit: this dig
                // cannot improve the state.
                if (groups.size === 1 && targetMass <= 1e-12) continue

                const nonTargetGroups = []
                for (const [code, branch] of groups) {
                  if (code === targetOutcomeCode) continue
                  if (branch.length) nonTargetGroups.push(branch)
                }

                // Canonicalize by posterior subsets, not raw outcome labels:
                // different cells that split the state identically are the
                // same decision for the one-target objective.
                const partitionKey = nonTargetGroups
                  .map(branch => branch.join(','))
                  .sort()
                  .join('|')
                if (seenPartitions.has(partitionKey)) continue
                seenPartitions.add(partitionKey)

                let future = 0
                for (const branch of nonTargetGroups) {
                  const p = posteriorWeight(branch) / total
                  if (p <= 0) continue
                  // Every non-target branch is a strict posterior reduction
                  // for useful actions, so recursion cannot cycle.
                  if (branch.length === indexes.length) {
                    future = Infinity
                    break
                  }
                  future += p * optimalCost(branch)
                }

                const cost = 1 + future
                if (cost < best) best = cost
              }

              optimalMemo.set(key, best)
              return best
            }

            const rootTotal = posteriorWeight(initialSolutions)
            for (const candidate of smartDigRanking) {
              const firstIdx = candidate.index
              if (!allActions.includes(firstIdx)) continue

              const groups = partitionForAction(initialSolutions, firstIdx)
              let expectedFuture = 0
              for (const [code, branch] of groups) {
                if (code === targetOutcomeCode) continue
                const p = posteriorWeight(branch) / rootTotal
                if (p <= 0) continue
                if (branch.length === initialSolutions.length) {
                  expectedFuture = Infinity
                  break
                }
                expectedFuture += p * optimalCost(branch)
              }

              candidate.expectedDigsToComplete = 1 + expectedFuture
              candidate.adaptiveScore = -candidate.expectedDigsToComplete
              candidate.lookaheadCapped = false
              candidate.endgameOptimal = true
              candidate.endgameStateCount = optimalStates
              candidate.adaptiveDepth = 0
            }

            for (const candidate of smartDigRanking) {
              if (candidate.endgameOptimal) {
                candidate.endgameStateCount = optimalStates
              }
            }
          }

          smartDigRanking.sort((a, b) =>
            (a.expectedDigsToComplete ?? Infinity) -
              (b.expectedDigsToComplete ?? Infinity) ||
            b.targetHitProbability - a.targetHitProbability ||
            b.targetInfoGain - a.targetInfoGain ||
            a.index - b.index
          )

          const bestDirectExact = [...smartDigRanking]
            .filter(item => item.targetHitProbability > 0)
            .sort((a, b) =>
              b.targetHitProbability - a.targetHitProbability ||
              (a.expectedDigsToComplete ?? Infinity) -
                (b.expectedDigsToComplete ?? Infinity) ||
              a.index - b.index
            )[0] ?? null

          // Exact-but-capped horizon search is much more trustworthy than the
          // reduced model, but still not proof-quality. Require a small margin
          // before sacrificing a stronger direct hit. Fully optimal endgames
          // never use this guard.
          const exactPreferred = smartDigRanking[0] ?? null
          if (
            exactPreferred &&
            bestDirectExact &&
            !exactPreferred.endgameOptimal &&
            exactPreferred.lookaheadCapped &&
            exactPreferred.index !== bestDirectExact.index &&
            Number.isFinite(exactPreferred.expectedDigsToComplete) &&
            Number.isFinite(bestDirectExact.expectedDigsToComplete)
          ) {
            const exactMargin = 0.20
            const modelAdvantage =
              bestDirectExact.expectedDigsToComplete -
              exactPreferred.expectedDigsToComplete
            exactPreferred.robustCostMargin = exactMargin
            exactPreferred.robustCostAdvantage = modelAdvantage

            if (modelAdvantage < exactMargin - 1e-12) {
              bestDirectExact.robustFallbackUsed = true
              bestDirectExact.robustReason = 'capped-exact-cost-margin'
              bestDirectExact.robustCostMargin = exactMargin
              bestDirectExact.robustCostAdvantage = modelAdvantage
              bestDirectExact.modelPreferredIndex = exactPreferred.index
              bestDirectExact.modelPreferredProbability =
                exactPreferred.targetHitProbability
              bestDirectExact.modelPreferredExpectedDigs =
                exactPreferred.expectedDigsToComplete

              const directPosition = smartDigRanking.indexOf(bestDirectExact)
              if (directPosition > 0) {
                smartDigRanking.splice(directPosition, 1)
                smartDigRanking.unshift(bestDirectExact)
              }
            }
          }

          if (smartDigRanking[0] && bestDirectExact) {
            smartDigRanking[0].bestDirectAlternativeIndex = bestDirectExact.index
            smartDigRanking[0].bestDirectAlternativeProbability =
              bestDirectExact.targetHitProbability
            smartDigRanking[0].bestDirectAlternativeExpectedDigs =
              Number.isFinite(bestDirectExact.expectedDigsToComplete)
                ? bestDirectExact.expectedDigsToComplete
                : null
          }
        } else {
          // If no target is selected (or its location is already fully known),
          // fall back to generic whole-board information gain.
          for (const [idx, counts] of outcomeCounts) {
            if (actuallyRevealedCells.has(idx)) continue

            let sumSquares = 0
            let largestBucket = 0
            const outcomes = []
            for (const [outcome, count] of counts) {
              const p = count / globalSolutionCount
              sumSquares += p * p
              largestBucket = Math.max(largestBucket, count)
              outcomes.push({ outcome, probability: p, count })
            }

            outcomes.sort((a, b) =>
              b.probability - a.probability || a.outcome.localeCompare(b.outcome)
            )

            smartDigRanking.push({
              index: idx,
              expectedElimination: 1 - sumSquares,
              worstCaseElimination: 1 - (largestBucket / globalSolutionCount),
              outcomes,
              targetAware: false,
            })
          }

          smartDigRanking.sort((a, b) =>
            b.expectedElimination - a.expectedElimination ||
            b.worstCaseElimination - a.worstCaseElimination ||
            a.index - b.index
          )
        }

        smartDig = smartDigRanking[0] ?? null

        if (targetComplete && normalizedProbabilityTarget) {
          // The selected object has already been found as many times as today's
          // patterns require. Do not keep suggesting hypothetical extra copies.
          for (const byName of probabilities.values()) {
            byName.delete(normalizedProbabilityTarget)
          }
          smartDig = null
          smartDigRanking = []
          targetPlan = null
        }
      } else if (probabilityReason === 'too-complex') {
        // Never expose the deterministic global DFS prefix as a probability.
        // Use the cheap local map for all objects, but replace the SELECTED
        // target with an exact reduced target-pattern model whenever that
        // smaller search completes. This gives a much stronger opening move.
        probabilities = localEstimate
        const openingModel = buildTargetOpeningModel()
        targetProbabilities = new Map()

        if (openingModel) {
          targetProbabilities = openingModel.targetProbabilities
          targetLayoutCount = openingModel.targetLayoutCount ?? 0
          smartDigRanking = openingModel.ranking
          smartDig = openingModel.best
        } else if (normalizedProbabilityTarget) {
          for (const [idx, byName] of localEstimate) {
            const p = byName.get(normalizedProbabilityTarget) ?? 0
            if (p > 0) targetProbabilities.set(idx, p)
          }
        }

        probabilityMode = 'approximate'
        if (targetComplete && normalizedProbabilityTarget) {
          for (const byName of probabilities.values()) {
            byName.delete(normalizedProbabilityTarget)
          }
          targetProbabilities = new Map()
          smartDig = null
          smartDigRanking = []
          targetPlan = null
        }
      } else {
        probabilities = new Map()
        probabilityMode = 'none'
      }
    }
  }

  return {
    guaranteed,
    guaranteedSlugs,
    guaranteedCandidates,
    guaranteedFormationCounts,
    remainingCounts,
    remainingRegions,
    possibleTreasureCells,
    probabilities,
    targetProbabilities,
    globalSolutionCount,
    probabilityComplete,
    probabilityReason,
    probabilityMode,
    smartDig,
    smartDigRanking,
    targetPlan,
    targetComplete,
    targetRequiredCount,
    targetFoundCount,
    targetRemainingCount,
    targetLayoutCount,
    partial: false,
  }
}
