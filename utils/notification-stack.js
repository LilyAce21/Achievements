"use strict";

// Rules and layout for stacked achievement notifications. Pure functions, so they can be tested
// without Electron. Only Bronze and Silver (and un-tiered) notifications stack; Gold, Sapphire,
// Platinum and PSN Platinum always show alone.

const STACK_LIMIT = 3;
const STACK_GAP_PX = 8;
// How much of the old visible gap between stacked cards is removed.
const STACK_GAP_REDUCTION = 0.85;
const STACKABLE_TIERS = new Set(["", "bronze", "silver"]);
const BOTTOM_POSITIONS = new Set(["center-bottom", "bottom-right", "bottom-left"]);

function clampStackMax(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return STACK_LIMIT;
  return Math.min(STACK_LIMIT, Math.max(1, number));
}

/** Whether a notification may share the screen with others. */
function isStackableTier({ rarityTier, isPlatinum, isPsnPlatinum, drawnBySystem }) {
  if (isPlatinum === true || isPsnPlatinum === true || drawnBySystem === true) return false;
  return STACKABLE_TIERS.has(String(rarityTier || "").toLowerCase());
}

/**
 * Whether the next queued notification may start now.
 * Anything may start on an empty screen. After that only a stackable one may join a stack of
 * stackable ones, and only while there is a free slot; an exclusive one waits for an empty screen.
 */
function canStart({ activeCount, activeExclusiveCount, candidateStackable, max }) {
  if (activeCount === 0) return true;
  if (activeExclusiveCount > 0) return false;
  if (!candidateStackable) return false;
  return activeCount < clampStackMax(max);
}

/**
 * The space left between two neighbouring cards as the eye sees it. A notification window carries
 * a transparent margin (`inset`) above and below its card, so two windows set edge to edge leave
 * both margins plus the gap between them. This is 15% of that old visible gap, never less than 1px.
 */
function visibleGapBetween(insetA, insetB, gap = STACK_GAP_PX) {
  const before = Math.max(0, insetA) + Math.max(0, insetB) + gap;
  return Math.max(1, Math.round(before * (1 - STACK_GAP_REDUCTION)));
}

/**
 * Where each card of one position's stack goes, newest on top.
 * `group` is oldest first, each { anchor: { x, y, width, height }, inset } where the anchor is where
 * the card would sit alone and `inset` is the transparent margin above and below its card.
 * Cards are spaced by their visible edges, so the margins overlap. Top-anchored and middle
 * positions push older cards down; bottom-anchored positions keep older cards in place and add new
 * ones above them.
 * @returns {{ x: number, y: number }[]} one entry per card, in the same order as `group`
 */
function computeStackPositions(group, position) {
  if (!Array.isArray(group) || group.length === 0) return [];
  const inset = (entry) => Math.max(0, Number(entry?.inset) || 0);
  const out = new Array(group.length);
  if (BOTTOM_POSITIONS.has(position)) {
    // Oldest sits where it would alone; each newer card goes above the one before it.
    out[0] = { x: group[0].anchor.x, y: group[0].anchor.y };
    for (let index = 1; index < group.length; index += 1) {
      const below = group[index - 1];
      const card = group[index];
      const gap = visibleGapBetween(inset(card), inset(below));
      out[index] = {
        x: card.anchor.x,
        y: Math.round(out[index - 1].y + inset(below) + inset(card) - gap - card.anchor.height),
      };
    }
  } else {
    // Newest sits where it would alone; each older card goes below the one before it.
    const last = group.length - 1;
    out[last] = { x: group[last].anchor.x, y: group[0].anchor.y };
    for (let index = last - 1; index >= 0; index -= 1) {
      const above = group[index + 1];
      const card = group[index];
      const gap = visibleGapBetween(inset(above), inset(card));
      out[index] = {
        x: card.anchor.x,
        y: Math.round(out[index + 1].y + above.anchor.height - inset(above) - inset(card) + gap),
      };
    }
  }
  return out;
}

const STACK_SLIDE_MS = 220;

function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  return 1 - Math.pow(1 - x, 3);
}

/** The y a sliding card should be at, `elapsedMs` into a slide from `fromY` to `toY`. */
function slideY(fromY, toY, elapsedMs, durationMs = STACK_SLIDE_MS) {
  if (!(durationMs > 0) || elapsedMs >= durationMs) return Math.round(toY);
  return Math.round(fromY + (toY - fromY) * easeOutCubic(elapsedMs / durationMs));
}

module.exports = {
  STACK_LIMIT,
  STACK_GAP_PX,
  STACK_GAP_REDUCTION,
  STACK_SLIDE_MS,
  visibleGapBetween,
  clampStackMax,
  isStackableTier,
  canStart,
  computeStackPositions,
  easeOutCubic,
  slideY,
};
