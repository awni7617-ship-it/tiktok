import { describe, expect, it } from 'vitest';
import { nextSlots, postsPerDay, queueDepth } from '@/server/schedule/cadence';

/** A Wednesday at 12:00, so "next slot" crosses a day boundary in both directions. */
const WEDNESDAY_NOON = new Date(2026, 0, 7, 12, 0, 0);

describe('nextSlots', () => {
  it('returns nothing for a manual channel', () => {
    expect(nextSlots('manual', [9], 3, WEDNESDAY_NOON)).toEqual([]);
  });

  it('returns nothing when asked for nothing', () => {
    expect(nextSlots('daily', [9], 0, WEDNESDAY_NOON)).toEqual([]);
  });

  it('puts daily slots on consecutive days at the chosen hour', () => {
    const slots = nextSlots('daily', [18], 3, WEDNESDAY_NOON);

    expect(slots).toHaveLength(3);
    expect(slots[0]!.getDate()).toBe(7); // 18:00 today is still ahead
    expect(slots[1]!.getDate()).toBe(8);
    expect(slots[2]!.getDate()).toBe(9);
    for (const slot of slots) expect(slot.getHours()).toBe(18);
  });

  it('skips a slot that has already passed today', () => {
    const slots = nextSlots('daily', [9], 2, WEDNESDAY_NOON);

    // 09:00 Wednesday is behind us, so the first slot is Thursday.
    expect(slots[0]!.getDate()).toBe(8);
    expect(slots[1]!.getDate()).toBe(9);
  });

  it('lands three-per-week on Monday, Wednesday and Friday', () => {
    const slots = nextSlots('three-per-week', [9], 3, WEDNESDAY_NOON);

    // Wednesday 09:00 has passed, so: Fri, Mon, Wed.
    expect(slots.map((s) => s.getDay())).toEqual([5, 1, 3]);
  });

  it('uses both hours for a twice-daily cadence', () => {
    const slots = nextSlots('twice-daily', [8, 20], 4, WEDNESDAY_NOON);

    expect(slots.map((s) => s.getHours())).toEqual([20, 8, 20, 8]);
    expect(slots.map((s) => s.getDate())).toEqual([7, 8, 8, 9]);
  });

  it('orders the hours it was given', () => {
    const slots = nextSlots('twice-daily', [20, 8], 2, WEDNESDAY_NOON);
    expect(slots.map((s) => s.getHours())).toEqual([20, 8]);
  });

  it('ignores hours outside a day and falls back rather than producing nothing', () => {
    const slots = nextSlots('daily', [99, -4], 2, WEDNESDAY_NOON);

    expect(slots).toHaveLength(2);
    expect(slots[0]!.getHours()).toBe(9);
  });

  it('only takes as many hours as the cadence posts per day', () => {
    // Two hours given, but "daily" posts once — the later one is dropped.
    const slots = nextSlots('daily', [8, 20], 2, WEDNESDAY_NOON);
    expect(slots.map((s) => s.getHours())).toEqual([8, 8]);
  });

  it('never returns a slot at or before the reference time', () => {
    const exactly = new Date(2026, 0, 7, 9, 0, 0);
    const slots = nextSlots('daily', [9], 1, exactly);

    expect(slots[0]!.getTime()).toBeGreaterThan(exactly.getTime());
  });
});

describe('queueDepth and postsPerDay', () => {
  it('queues more ahead for busier cadences', () => {
    expect(queueDepth('twice-daily')).toBeGreaterThan(queueDepth('daily'));
    expect(queueDepth('daily')).toBeGreaterThan(queueDepth('three-per-week'));
    expect(queueDepth('manual')).toBe(0);
  });

  it('reports two posts a day only for twice-daily', () => {
    expect(postsPerDay('twice-daily')).toBe(2);
    expect(postsPerDay('daily')).toBe(1);
    expect(postsPerDay('manual')).toBe(0);
  });
});
