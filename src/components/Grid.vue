<template>
  <div class="contain-please relative mt-0 sm:mt-1 mx-auto">
    <!-- COL LABELS OVERLAY -->
    <div class="overlay-cols text-[0.45rem] sm:text-[0.5rem] lg:text-xs">
      <div
        v-for="L in colLabels"
        :key="L"
        class="overlay-cell justify-center items-end"
      >
        {{ L }}
      </div>
    </div>

    <!-- ROW LABELS OVERLAY -->
    <div
      class="overlay-rows text-base-content text-[0.45rem] sm:text-[0.5rem] lg:text-xs"
    >
      <div
        v-for="N in rowLabels"
        :key="N"
        class="overlay-cell justify-end items-center"
      >
        {{ N }}
      </div>
    </div>

    <div class="grid w-full p-0.5 gap-0.5 bg-base-300 dark:bg-slate-500">
      <div
        v-for="(tile, index) in tiles"
        :key="index"
        class="tile w-full flex items-center bg-base-100 justify-center aspect-square relative"
        :class="tileClasses(tile, index)"
        @click="onTileClick($event, index)"
        @contextmenu.prevent="onTileClick($event, index)"
      >
        <!-- underlying image -->
        <img
          v-if="getTileImage(normalizeTile(tile))"
          :src="getImageSrc(getTileImage(normalizeTile(tile))).value"
          alt="treasure"
          class="tile-img"
        />

        <!-- Prediction: the guaranteed treasure's actual image -->
        <img
          v-else-if="predictionSlug(index)"
          :src="getImageSrc('/world/' + predictionSlug(index) + '.webp').value"
          class="tile-img prediction-img"
          alt="predicted treasure"
        />

        <!-- Prediction: guaranteed treasure, exact type unknown -->
        <span
          v-else-if="predictionUnknown(index)"
          class="prediction-unknown"
          :title="predictionUnknownTitle(index)"
        >?</span>

        <!-- Target-specific probability overlay. Guaranteed predictions keep
             priority through the existing image/unknown rendering above. -->
        <span
          v-if="probabilityPercent(index) !== null"
          class="probability-badge"
          :class="probabilityBadgeClass(index)"
          :title="probabilityTitle(index)"
        >
          <template v-if="probabilityRank(index)">#{{ probabilityRank(index) }} · </template>{{ probabilityPrefix }}{{ probabilityPercent(index) }}%
        </span>

        <span
          v-if="showProbability && targetPlanStep(index)"
          class="plan-step-badge"
          :title="targetPlanStepTitle(index)"
        >P{{ targetPlanStep(index).step }}</span>

        <span
          v-if="showProbability && smartDig?.index === index"
          class="smart-dig-badge"
          :title="smartDigTitle"
        >BEST</span>

        <!-- transient shovel dig reveal overlay for freshly-dug tiles.
             Kept outside the tile-img/prediction v-if chain so it doesn't
             break it; it's an absolute overlay so DOM order is irrelevant. -->
        <img
          v-if="newlyDug.has(index)"
          class="tile-shovel"
          :src="getImageSrc('/images/sand-shovel.png').value"
          alt=""
        />

        <!-- number label mark (keys 1–0) -->
        <span
          v-if="getTileLabelMark(tile)"
          class="hint-label-digit"
          :title="`Dig order: ${getTileLabelMark(tile)}`"
        >
          {{ getTileLabelMark(tile) }}
        </span>

        <!-- treasure order badge -->
        <span
          v-if="showTreasureOrder && treasureOrderMap[index]"
          class="absolute top-0 right-0
            w-full h-full
            transform origin-top-right scale-[0.33333]
            flex items-center justify-center
            bg-base-200 rounded-full shadow
            text-2xl md:text-3xl p-1 font-bold
            pointer-events-none overflow-hidden"
        >
          {{ treasureOrderMap[index] }}
        </span>
      </div>
    </div>

    <div
      v-if="showProbability && targetPlan?.steps?.length"
      class="target-plan-summary"
    >
      <div class="font-semibold">Target plan</div>
      <div class="flex flex-wrap gap-x-3 gap-y-1 justify-center">
        <span
          v-for="step in targetPlan.steps"
          :key="step.index"
        >
          {{ cellLabel(step.index) }}:
          <strong>{{ Math.round(step.cumulativeProbability * 100) }}%</strong>
          within {{ step.step }} {{ step.step === 1 ? 'dig' : 'digs' }}
        </span>
      </div>
    </div>

    <!-- backdrop to close picker -->
    <div v-if="picker" class="fixed inset-0 z-40" @click="picker = null"></div>

    <!-- hint picker popup -->
    <HintPicker
      v-if="picker"
      :tileIndex="picker.tileIndex"
      :x="picker.x"
      :y="picker.y"
      :hints="[
        'hint-red-dot',
        'hint-potential-treasure',
        'hint-potential-treasure2',
        'hint-sand tileImage:sand',
        'hint-treasure',
        'hint-crab tileImage:crab',
        'hint-nothing',
        'no-hint-and-show-trash-icon',
        'hint-crab-eyes-maybe',
      ]"
      @pick="onHintPicked"
      @report="onReportFromPicker"
      :possibleTreasures="possibleTreasures"
      :cell-probabilities="pickerProbabilityItems"
      :probability-approximate="probabilityMode === 'approximate'"
    />

    <!-- BottomGridInfo component -->
    <BottomGridInfo :show-land-id-in-url="showLandIdInUrl" />
  </div>
</template>

<script setup>
import { ref, computed, toRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useGridManager } from '@/composables/useGridManager'
import HintPicker from '@/components/HintPicker.vue'
import BottomGridInfo from './BottomGridInfo.vue'

import { useTodayTreasureNames } from "@/composables/useTodayTreasureNames";
import { useLandData } from '@/composables/useLandData.js'
import { usePredictionEngine } from '@/composables/usePredictionEngine.js'
import { useReliableAssets } from '@/composables/useReliableAssets.js'
import { getLabelFromTile } from '@/utils/hintLabel.js'
import { isRevealed } from '@/utils/tileState.js'
import { useFeedbackModal } from '@/composables/useFeedbackModal.js'
import { getTreasureProbability, treasureDisplayName } from '@/utils/treasureProbability.js'

// Use reliable assets composable
const { getImageSrc } = useReliableAssets()

const possibleTreasures = useTodayTreasureNames();
console.log("Trigger computed value:", possibleTreasures.value); // this seems to forcely trigger the computed value
// your existing props
const { showTreasureOrder, treasureOrderMap, showLandIdInUrl, showPrediction, interactive, showProbability, probabilityTarget } = defineProps({
  showTreasureOrder: { type: Boolean, default: false },
  treasureOrderMap:  { type: Array,   default: () => [] },
  showLandIdInUrl:   { type: Boolean, default: true },
  showPrediction:    { type: Boolean, default: false },
  interactive:       { type: Boolean, default: true },
  showProbability:    { type: Boolean, default: false },
  probabilityTarget:  { type: String, default: '' },
})

// init grid manager
const route  = useRoute()
const landId = route.params.landId || '0'
const grid   = useGridManager(landId)

// reactive tiles & picker
const tiles  = grid.tiles
const newlyDug = grid.newlyDug
const picker = ref(null)

// ── Prediction engine ──
// Pass the FULL board multiset (not minus-completed): the solver anchors on
// revealed treasures, so a treasure from a completed formation must still be
// able to anchor to its shape. Including all shapes only ever makes deductions
// more conservative (never a wrong guarantee).
const { solverPatternKeys } = useLandData()
const { guaranteed, guaranteedSlugs, guaranteedCandidates, probabilities, globalSolutionCount, probabilityComplete, probabilityMode, smartDig, smartDigRanking, targetPlan } = usePredictionEngine(
  tiles,
  solverPatternKeys,
  toRef(() => showPrediction || showProbability),
  {
    probabilityRef: toRef(() => showProbability),
    probabilityTargetRef: toRef(() => probabilityTarget),
  },
)

// Feed the guaranteed set into the engine as a treasure mask so a crab adjacent
// to a guaranteed cell suppresses its near-crab halo (same as the `s` mark).
// When the toggle is OFF the mask is empty → original behavior restored.
watch(
  [guaranteed, () => showPrediction],
  ([g, on]) => grid.setPredictionMask(on ? g : new Set()),
  { immediate: true }
)

// The predicted treasure slug for a cell, iff prediction is on, the cell is
// guaranteed + unambiguous, and it isn't already revealed. Else null → the cell
// keeps the plain green outline + check badge (no image).
function predictionSlug(index) {
  if (!showPrediction) return null
  if (!guaranteed.value.has(index)) return null
  if (isRevealed(tiles.value[index])) return null
  return guaranteedSlugs.value.get(index) ?? null
}

// True when a cell is a guaranteed treasure but its exact type is ambiguous
// (guaranteed + unrevealed, yet no agreed name) → show a "?" instead of an image.
function predictionUnknown(index) {
  if (!showPrediction) return false
  if (!guaranteed.value.has(index)) return false
  if (isRevealed(tiles.value[index])) return false
  return !guaranteedSlugs.value.has(index)
}

// Explainer tooltip for the "?" — lists the candidate identities the solver is
// still weighing (e.g. "could be Camel Bone or Otter Pebble"), so an ambiguous
// mark reads as a sound deduction instead of a mystery. Falls back to the old
// generic text when the solver reports no candidates for the cell.
function predictionUnknownTitle(index) {
  const candidates = guaranteedCandidates.value.get(index)
  if (candidates?.length) {
    const names = candidates.map(s => s.replace(/_/g, ' ')).join(', ')
    return `Guaranteed treasure — could be: ${names}`
  }
  return 'Guaranteed treasure — exact type unknown'
}

const probabilityPrefix = computed(() =>
  probabilityMode.value === 'approximate' ? '~' : ''
)

const probabilityRanks = computed(() => {
  const ranked = []
  if (!showProbability || !probabilityTarget) return new Map()

  for (let index = 0; index < tiles.value.length; index++) {
    if (isRevealed(tiles.value[index])) continue
    const probability = getTreasureProbability(
      probabilities.value,
      index,
      probabilityTarget,
    )
    if (probability > 0) ranked.push({ index, probability })
  }

  ranked.sort((a, b) =>
    b.probability - a.probability || a.index - b.index
  )

  return new Map(
    ranked.slice(0, 10).map((entry, i) => [entry.index, i + 1]),
  )
})

function probabilityRank(index) {
  return probabilityRanks.value.get(index) ?? null
}

function probabilityBadgeClass(index) {
  const rank = probabilityRank(index)
  const pct = probabilityPercent(index)
  if (!rank || pct === null) return []
  const band = pct >= 50 ? 'probability-band-high'
    : pct >= 25 ? 'probability-band-medium'
      : pct >= 10 ? 'probability-band-low'
        : 'probability-band-very-low'
  return [band]
}

const smartDigTitle = computed(() => {
  if (!smartDig.value) return ''
  const col = String.fromCharCode(65 + (smartDig.value.index % 10))
  const row = Math.floor(smartDig.value.index / 10) + 1

  if (smartDig.value.targetAware) {
    const info = Math.round((smartDig.value.targetInfoGain ?? 0) * 100)
    const hit = Math.round((smartDig.value.targetHitProbability ?? 0) * 100)
    const label = probabilityTarget.replace(/_/g, ' ')
    return `Best next dig for ${label}: ${col}${row} — removes ~${info}% of remaining target-location uncertainty; ${hit}% direct hit chance`
  }

  const expected = Math.round((smartDig.value.expectedElimination ?? 0) * 100)
  const worst = Math.round((smartDig.value.worstCaseElimination ?? 0) * 100)
  return `Best next dig: ${col}${row} — expected to eliminate ${expected}% of valid boards (worst case ${worst}%)`
})

function probabilityPercent(index) {
  if (!showProbability || !probabilityTarget || isRevealed(tiles.value[index])) return null
  const p = getTreasureProbability(probabilities.value, index, probabilityTarget)
  if (p <= 0) return null
  return Math.round(p * 100)
}

function probabilityTitle(index) {
  const pct = probabilityPercent(index)
  if (pct === null) return ''
  const label = probabilityTarget.replace(/_/g, ' ')
  const mode = probabilityMode.value === 'exact' ? 'exact' : 'approximate'
  const rank = probabilityRank(index)
  const rankText = rank ? `Rank #${rank} — ` : ''
  return `${rankText}${mode === 'approximate' ? '~' : ''}${pct}% ${label} (${mode}${mode === 'exact' ? `, ${globalSolutionCount.value} valid boards` : ''})`
}

const pickerProbabilityItems = computed(() => {
  if (!showProbability || !picker.value) return []
  const byName = probabilities.value.get(picker.value.tileIndex)
  if (!byName) return []

  return [...byName.entries()]
    .filter(([, p]) => p > 0)
    .map(([slug, p]) => ({
      slug,
      label: treasureDisplayName(slug),
      percent: Math.round(p * 100),
      probability: p,
    }))
    .sort((a, b) =>
      b.probability - a.probability || a.label.localeCompare(b.label)
    )
})

function targetPlanStep(index) {
  return targetPlan.value?.steps?.find(step => step.index === index) ?? null
}

function cellLabel(index) {
  const col = String.fromCharCode(65 + (index % 10))
  const row = Math.floor(index / 10) + 1
  return `${col}${row}`
}

function targetPlanStepTitle(index) {
  const step = targetPlanStep(index)
  if (!step) return ''
  const cumulative = Math.round(step.cumulativeProbability * 100)
  const direct = Math.round(step.directProbability * 100)
  return `Plan step ${step.step}: ${cellLabel(index)} — ${direct}% direct hit, ${cumulative}% combined chance within ${step.step} dig${step.step === 1 ? '' : 's'}`
}

// static labels for overlays
const colLabels = computed(() =>
  Array.from({ length: 10 }, (_, i) =>
    String.fromCharCode(65 + i)  // A–J
  )
)
const rowLabels = computed(() =>
  Array.from({ length: 10 }, (_, i) => i + 1)  // 1–10
)

// click handler
function onTileClick (event, index) {
  if (!interactive) return
  const container   = event.currentTarget.closest('.contain-please')
  const containerR  = container.getBoundingClientRect()
  const tileR       = event.currentTarget.getBoundingClientRect()
  const centerX     = tileR.left - containerR.left + tileR.width  / 2
  const centerY     = tileR.top  - containerR.top  + tileR.height / 2

  picker.value = { tileIndex: index, x: centerX, y: centerY }
}

const { openFeedback } = useFeedbackModal()

function onHintPicked({ tileIndex, hint }) {
  grid.pick(tileIndex, hint)
  picker.value = null
}

function onReportFromPicker() {
  const p = picker.value
  if (p) {
    const col = colLabels.value[p.tileIndex % 10]
    const row = rowLabels.value[Math.floor(p.tileIndex / 10)]
    openFeedback({ tileLabel: `${col}${row}`, landId: landId ?? null, source: 'grid-context-menu' })
  } else {
    openFeedback({ source: 'grid-context-menu' })
  }
  picker.value = null
}


// image helper
function getTileImage(tile) {
  if (!Array.isArray(tile)) return null
  const match = tile.find(
    cls => typeof cls === 'string' && cls.includes('tileImage:')
  )
  if (!match) return null
  const slug = match.split(':')[1]
  return `/world/${slug}.webp`
}

function normalizeTile(tile) {
  if (Array.isArray(tile)) return tile;
  return String(tile).split(" ");
}

// Class list for a cell. A guaranteed prediction takes priority over speculative
// hint/near marks (e.g. the near-crab yellow overlay) so the guaranteed green
// reads cleanly — mirrors PracticeGrid.outerClasses ordering (commit ebfc06895).
function tileClasses(tile, index) {
  const classes = showPrediction && guaranteed.value.has(index) && !isRevealed(tile)
    ? ['predicted-guaranteed']
    : [...normalizeTile(tile)]

  const rank = probabilityRank(index)
  if (rank && !isRevealed(tile)) {
    classes.push('probability-top')
  }

  if (showProbability && targetPlanStep(index) && !isRevealed(tile)) {
    classes.push('target-plan-cell')
  }

  if (showProbability && smartDig.value?.index === index && !isRevealed(tile)) {
    classes.push('smart-dig-cell')
  }

  return classes
}

function getTileLabelMark (tile) {
  return getLabelFromTile(normalizeTile(tile))
}

</script>

<style scoped>
.contain-please {
  position: relative;
  /* carve out 1-tile space (10%) for overlays */
  --label-size: 10%;
  --badge-size: 3%;
  padding-top: 0px;
  padding-left: 0px;
}

.overlay-cols {
  position: absolute;
  top: calc(var(--label-size) * -1 + 1px);
  left: 0;
  width: calc(100%);
  height: var(--label-size);
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  pointer-events: none;
}

.overlay-rows {
  position: absolute;
  top: 0;
  left: calc(var(--label-size) * -1 - 2px);
  width: var(--label-size);
  height: calc(100%);
  display: grid;
  grid-template-rows: repeat(10, 1fr);
  pointer-events: none;
}

.overlay-cell {
  display: flex;
  user-select: none;
}

/* keep your existing tile-relative rule */
.tile {
  position: relative;
}

.probability-badge {
  position: absolute;
  right: 2px;
  bottom: 2px;
  z-index: 3;
  padding: 1px 3px;
  border-radius: 4px;
  font-size: 0.62rem;
  line-height: 1rem;
  font-weight: 700;
  background: rgba(0, 0, 0, 0.72);
  color: white;
  pointer-events: none;
}

.probability-top {
  box-shadow: inset 0 0 0 2px rgba(15, 23, 42, 0.35);
}

.probability-badge.probability-band-high { background: #16a34a; }
.probability-badge.probability-band-medium { background: #65a30d; }
.probability-badge.probability-band-low { background: #ca8a04; }
.probability-badge.probability-band-very-low { background: #475569; }

.smart-dig-cell {
  outline: 4px solid #7c3aed !important;
  outline-offset: -4px;
}

.smart-dig-badge {
  position: absolute;
  left: 2px;
  top: 2px;
  z-index: 4;
  padding: 1px 3px;
  border-radius: 4px;
  font-size: 0.55rem;
  line-height: 0.9rem;
  font-weight: 800;
  background: #7c3aed;
  color: white;
  pointer-events: none;
}

.target-plan-summary {
  margin-top: 0.5rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid rgba(124, 58, 237, 0.35);
  border-radius: 0.5rem;
  background: rgba(124, 58, 237, 0.08);
  font-size: 0.7rem;
  text-align: center;
}

.target-plan-cell {
  box-shadow: inset 0 0 0 2px #0ea5e9 !important;
}

.plan-step-badge {
  position: absolute;
  left: 2px;
  bottom: 2px;
  z-index: 4;
  padding: 1px 3px;
  border-radius: 4px;
  font-size: 0.55rem;
  line-height: 0.9rem;
  font-weight: 800;
  background: #0ea5e9;
  color: white;
  pointer-events: none;
}

.badge {
}
</style>
