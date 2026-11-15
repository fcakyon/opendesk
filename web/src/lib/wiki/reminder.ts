// The date mention's markup (contracts/wiki.md "Reminders"): `datetime` is a day
// ("2026-11-07"), a day and a local time ("2026-11-07T09:30"), or RFC 3339; a reminder is
// `data-reminder="<uuid>"` on it, which the API turns into a notification for whoever set it.

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type When = { date: string; time: string };

const pad = (n: number) => String(n).padStart(2, "0");

function realDay(v: string): boolean {
  const m = DAY.exec(v);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/** The day and time of day (on the reader's clock, "" for none) a `datetime` names; null when it names none. */
export function parseWhen(v: string | null | undefined): When | null {
  const s = (v ?? "").trim();
  if (realDay(s)) return { date: s, time: "" };
  const local = LOCAL.exec(s);
  if (local) return realDay(local[1]) ? { date: local[1], time: `${local[2]}:${local[3]}` } : null;
  if (RFC3339.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  return null;
}

/** The `datetime` for a day and an optional "HH:mm". */
export function formatWhen(date: string, time: string): string {
  return time ? `${date}T${time}` : date;
}

/** A reminder's id as the markup keeps it, or null. */
export function reminderId(v: string | null | undefined): string | null {
  return v && UUID.test(v) ? v.toLowerCase() : null;
}

export function newReminderId(): string {
  return crypto.randomUUID();
}
