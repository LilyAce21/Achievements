"use strict";

// Rules and layout for stacked achievement notifications. Pure functions, so they can be tested
// without Electron. Only Bronze and Silver (and un-tiered) notifications stack; Gold, Sapphire,
// Platinum and PSN Platinum always show alone.

const STACK_LIMIT = 3;
const STACK_GAP_PX = 8;
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
 * Where each card of one position's stack goes, newest on top.
 * `group` is oldest first, each { anchor: { x, y, width, height } } where the anchor is where the
 * card would sit alone. Top-anchored and middle positions push older cards down; bottom-anchored
 * positions keep older cards in place and add new ones above them.
 * @returns {{ x: number, y: number }[]} one entry per card, in the same order as `group`
 */
function computeStackPositions(group, position, gap = STACK_GAP_PX) {
  if (!Array.isArray(group) || group.length === 0) return [];
  const out = new Array(group.length);
  if (BOTTOM_POSITIONS.has(position)) {
    let cursor = group[0].anchor.y + group[0].anchor.height;
    for (let index = 0; index < group.length; index += 1) {
      const y = cursor - group[index].anchor.height;
      out[index] = { x: group[index].anchor.x, y: Math.round(y) };
      cursor = y - gap;
    }
  } else {
    let cursor = group[0].anchor.y;
    for (let index = group.length - 1; index >= 0; index -= 1) {
      out[index] = { x: group[index].anchor.x, y: Math.round(cursor) };
      cursor += group[index].anchor.height + gap;
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
  STACK_SLIDE_MS,
  clampStackMax,
  isStackableTier,
  canStart,
  computeStackPositions,
  easeOutCubic,
  slideY,
};
