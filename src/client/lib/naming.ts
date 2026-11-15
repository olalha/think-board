// What renaming a block will do, worked out before asking the server, so the
// name editor can show the file name a title gives (and refuse a taken name).
import { cleanTitle, displayName, isValidName, renameTarget } from "../../shared/blocks";

/**
 * The file name a rename to `text` gives the block, as the server picks it:
 * free text is made a name and, when that is taken, numbered (`tea-2`); a
 * plain name is used as typed (and refused if taken). Null when nothing changes
 * or the text is empty. `taken`: the other blocks' names and the frames' ids.
 */
export function renamePreview(
  text: string,
  name: string,
  title: string | undefined,
  taken: ReadonlySet<string>,
): { name: string; title?: string; error?: string } | null {
  const t = renameTarget(text, name);
  if (!t) return null;
  const text1 = cleanTitle(text)!;
  const plain = isValidName(text1);
  let next = t.name;
  if (next !== name && taken.has(next)) {
    if (plain) return { ...t, error: `“${displayName(next)}” exists` };
    for (let i = 2, base = next; taken.has(next); i++) next = `${base}-${i}`;
  }
  const out = { name: next, ...(!plain && text1 !== displayName(next) ? { title: text1 } : {}) };
  return out.name === name && out.title === title ? null : out;
}
