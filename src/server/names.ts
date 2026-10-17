import { isValidName } from "../shared/blocks.js";

/**
 * The first name from the pool that no block uses, in pool order. Once every
 * pool name is taken, cycle through the pool again with a suffix — `harry-2`,
 * `bob-2`, … then `harry-3` — so a name is always available.
 *
 * A name freed by deleting its block becomes available again, and is reused
 * before any suffixed name.
 */
export function allocateName(pool: readonly string[], taken: ReadonlySet<string>): string {
  const bases = [...new Set(pool.filter(isValidName))];
  if (bases.length === 0) bases.push("block");
  for (let round = 1; ; round++) {
    for (const base of bases) {
      const name = round === 1 ? base : `${base}-${round}`;
      if (!taken.has(name)) return name;
    }
  }
}
