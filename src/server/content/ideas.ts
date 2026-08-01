import { niche } from '@/lib/catalog';
import type { Video } from '@/lib/types';

/**
 * Picking what the next autopilot video is about.
 *
 * A channel on autopilot needs a topic without being asked for one. The seeds
 * in the niche catalog are angles rather than subjects — "a border with a
 * strange shape and a real reason" — so the script model still does the
 * choosing, and two videos from the same seed do not come out the same.
 */

/**
 * Rotate through the niche's seeds, offset by how many videos the channel has
 * already made, so the first four videos on a channel are four different
 * angles instead of four rolls of the same die.
 */
export function nextIdea(nicheId: string, existing: Video[]): string {
  const found = niche(nicheId);
  if (!found || found.seeds.length === 0) {
    return 'an interesting fact worth ninety seconds';
  }

  const used = existing.filter((v) => v.idea !== null).length;
  const seed = found.seeds[used % found.seeds.length]!;

  return `${seed} (${found.name.toLowerCase()})`;
}
