import { withKey, apiOk, apiErr, keyCan } from '@/lib/api-v1';
import { getEvents } from '@/lib/data';

export const dynamic = 'force-dynamic';

// GET /api/v1/conflicts — cases double-booked across time-overlapping events. A case is in conflict
// when two or more of the (active, dated) events it's assigned to overlap in time. Closed/cancelled
// events are ignored. ISO date strings compare lexicographically, so the overlap test is a string
// compare (start <= otherEnd && otherStart <= end).
interface Slot {
  id: string;
  name: string;
  start: string;
  end: string;
  state: string;
}

export async function GET(req: Request) {
  return withKey(req, async (vk) => {
    if (!keyCan(vk, 'db.read.session')) return apiErr(403, 'this key cannot read');
    const events = await getEvents();
    const dead = new Set(['closed', 'cancelled', 'canceled']);

    // caseId -> the dated, active events that hold it.
    const byCase = new Map<string, Slot[]>();
    for (const e of events) {
      const p = e.payload;
      if (dead.has(String(p.state))) continue;
      if (!p.startDate) continue;
      const slot: Slot = {
        id: e._id,
        name: p.name || e._id,
        start: p.startDate,
        end: p.endDate || p.startDate,
        state: String(p.state),
      };
      for (const cid of p.cases ?? []) {
        const arr = byCase.get(String(cid)) || [];
        arr.push(slot);
        byCase.set(String(cid), arr);
      }
    }

    const overlap = (a: Slot, b: Slot) => a.start <= b.end && b.start <= a.end;

    const conflicts: { caseId: string; events: Slot[] }[] = [];
    for (const [caseId, slots] of byCase) {
      if (slots.length < 2) continue;
      const involved = new Set<number>();
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          if (overlap(slots[i], slots[j])) {
            involved.add(i);
            involved.add(j);
          }
        }
      }
      if (involved.size >= 2) {
        conflicts.push({ caseId, events: [...involved].sort((a, b) => a - b).map((k) => slots[k]) });
      }
    }
    conflicts.sort((a, b) => b.events.length - a.events.length);
    return apiOk({ conflicts, count: conflicts.length });
  });
}
