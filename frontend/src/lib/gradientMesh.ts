// src/lib/gradientMesh.ts - Deterministic CSS gradient-mesh background for a
// forum's banner fallback when no banner image is set. Pure function of the
// forum name (hashed via keccak256Utf8, same as ForumIcon's seed) - the same
// name always produces the same background.

import { keccak256Utf8 } from "./hash";

/**
 * Builds a CSS `background` value (three radial gradients + a linear base) whose hues are derived from `seed`.
 * @param seed - text to hash for hue selection, typically the forum name.
 * @returns a CSS `background` shorthand value.
 */
export function gradientMeshBackground(seed: string): string {
  const hash = keccak256Utf8(seed).slice(2);
  const hue1 = parseInt(hash.slice(0, 4), 16) % 360;
  const hue2 = parseInt(hash.slice(4, 8), 16) % 360;
  const hue3 = parseInt(hash.slice(8, 12), 16) % 360;

  return [
    `radial-gradient(at 15% 20%, hsl(${hue1}, 70%, 55%) 0px, transparent 55%)`,
    `radial-gradient(at 85% 25%, hsl(${hue2}, 70%, 55%) 0px, transparent 55%)`,
    `radial-gradient(at 50% 90%, hsl(${hue3}, 70%, 55%) 0px, transparent 60%)`,
    `linear-gradient(135deg, hsl(${hue1}, 40%, 30%), hsl(${hue3}, 40%, 20%))`,
  ].join(", ");
}
