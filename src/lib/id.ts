/**
 * Sortable ids: a base36 timestamp followed by randomness. Sorting a list of
 * ids lexicographically puts it in creation order, which saves a comparator
 * every time something is listed.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${time}${rand}`;
}

/** Filesystem-safe slug, used for output filenames. */
export function slug(input: string, max = 48): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'untitled').slice(0, max).replace(/-+$/, '');
}
