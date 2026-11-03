import type { BufferService, SlotPlan } from './types.js';

/** ISO week id like 2026-W46 for a date (UTC-based ISO week). */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Monday 00:00 (local wall clock in tz) of the ISO week that contains `d`, returned as a wall-clock Y-M-D. */
export function mondayOfWeek(d: Date, tz: string): { y: number; m: number; day: number } {
  const local = wallClock(d, tz);
  const date = new Date(Date.UTC(local.y, local.m - 1, local.day));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (dow - 1));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function wallClock(d: Date, tz: string): { y: number; m: number; day: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: get('year'), m: get('month'), day: get('day'), hh: get('hour') % 24, mm: get('minute') };
}

/** Convert a wall-clock time in `tz` to a UTC Date (handles DST by iterating offset). */
export function zonedTimeToUtc(y: number, m: number, day: number, hh: number, mm: number, tz: string): Date {
  let guess = Date.UTC(y, m - 1, day, hh, mm);
  for (let i = 0; i < 3; i++) {
    const wc = wallClock(new Date(guess), tz);
    const asUtc = Date.UTC(wc.y, wc.m - 1, wc.day, wc.hh, wc.mm);
    const diff = Date.UTC(y, m - 1, day, hh, mm) - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function parseSlots(spec: string): { hh: number; mm: number }[] {
  const slots = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new Error(`bad slot "${s}", expected HH:MM`);
    return { hh: Number(m[1]), mm: Number(m[2]) };
  });
  if (slots.length !== 3) throw new Error(`PUBLISH_SLOTS must contain exactly 3 daily times, got ${slots.length}`);
  return slots;
}

/**
 * Build the 21-slot plan for the week starting on the Monday after `from` (never the current week,
 * so there is always a full review window). Each slot gets both services at the same instant.
 */
export function buildWeekPlan(from: Date, tz: string, slotSpec: string, services: BufferService[] = ['youtube', 'tiktok']): SlotPlan {
  const slots = parseSlots(slotSpec);
  const thisMonday = mondayOfWeek(from, tz);
  const nextMondayUtc = new Date(Date.UTC(thisMonday.y, thisMonday.m - 1, thisMonday.day + 7));
  const plan: SlotPlan = { week: isoWeek(nextMondayUtc), slots: [] };
  for (let i = 0; i < 7; i++) {
    const day = new Date(nextMondayUtc.getTime() + i * 86400000);
    for (const s of slots) {
      const at = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s.hh, s.mm, tz);
      for (const service of services) plan.slots.push({ slot_at: at.toISOString(), service });
    }
  }
  return plan;
}

/** Format an ISO UTC instant as Buffer's expected `YYYY-MM-DDThh:mm:ss±hh:mm` in `tz`. */
export function toBufferDueAt(iso: string, tz: string): string {
  const d = new Date(iso);
  const wc = wallClock(d, tz);
  const asUtc = Date.UTC(wc.y, wc.m - 1, wc.day, wc.hh, wc.mm);
  const offsetMin = Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${wc.y}-${pad(wc.m)}-${pad(wc.day)}T${pad(wc.hh)}:${pad(wc.mm)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
