import type { Cadence } from '@/lib/types';

/**
 * Turning a cadence into actual posting times.
 *
 * Pure and timezone-naive-by-design: slots are computed in the host's local
 * time, which for a single-user app running on the user's own machine is the
 * timezone they mean. Everything is exchanged as epoch millis so nothing
 * downstream has to reason about it.
 */

/** Which weekdays a cadence posts on. 0 = Sunday. */
function activeDays(cadence: Cadence): number[] {
  switch (cadence) {
    case 'three-per-week':
      return [1, 3, 5]; // Mon, Wed, Fri
    case 'daily':
    case 'twice-daily':
      return [0, 1, 2, 3, 4, 5, 6];
    case 'manual':
      return [];
  }
}

/** How many posts land on each active day. */
export function postsPerDay(cadence: Cadence): number {
  return cadence === 'twice-daily' ? 2 : cadence === 'manual' ? 0 : 1;
}

function atHour(day: Date, hour: number): Date {
  const slot = new Date(day);
  slot.setHours(hour, 0, 0, 0);
  return slot;
}

/**
 * The next `count` posting slots strictly after `after`.
 *
 * Walks forward day by day rather than computing an interval, because "three
 * per week" is Monday/Wednesday/Friday, not "every 56 hours" — the second
 * drifts across the week and eventually posts at 3am.
 */
export function nextSlots(
  cadence: Cadence,
  postingHours: number[],
  count: number,
  after: Date = new Date(),
): Date[] {
  const days = activeDays(cadence);
  if (days.length === 0 || count <= 0) return [];

  const perDay = postsPerDay(cadence);
  const hours = [...postingHours]
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b)
    .slice(0, perDay);

  // A channel with no usable hours still needs somewhere to put its posts.
  const usable = hours.length ? hours : perDay === 2 ? [9, 18] : [9];

  const slots: Date[] = [];
  const cursor = new Date(after);
  cursor.setHours(0, 0, 0, 0);

  // 60 days is far past any cadence's next few slots; the bound exists so a
  // bad cadence cannot spin here forever.
  for (let dayOffset = 0; dayOffset < 60 && slots.length < count; dayOffset++) {
    const day = new Date(cursor);
    day.setDate(day.getDate() + dayOffset);
    if (!days.includes(day.getDay())) continue;

    for (const hour of usable) {
      if (slots.length >= count) break;
      const slot = atHour(day, hour);
      if (slot.getTime() > after.getTime()) slots.push(slot);
    }
  }

  return slots;
}

/**
 * How many videos autopilot should have queued ahead.
 *
 * Enough to cover a lead time — rendering takes minutes and a provider can be
 * down — without building a backlog nobody will ever watch.
 */
export function queueDepth(cadence: Cadence): number {
  switch (cadence) {
    case 'twice-daily':
      return 4;
    case 'daily':
      return 3;
    case 'three-per-week':
      return 2;
    case 'manual':
      return 0;
  }
}
