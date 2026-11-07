const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const morning = 9;

export function parseWhen(text: string, now: number): number | undefined {
  const words = text.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return undefined;
  const at = words.length === 1 ? (after(words[0]!, now) ?? onDay(words, now)) : onDay(words, now);
  return at !== undefined && at > now ? at : undefined;
}

function after(word: string, now: number): number | undefined {
  const match = /^(\d+)(m|min|h|hr|d)$/.exec(word);
  if (!match) return undefined;
  const count = Number(match[1]);
  const unit = match[2]!.startsWith("m") ? 60_000 : match[2]!.startsWith("h") ? 3_600_000 : 86_400_000;
  return now + count * unit;
}

function onDay(words: string[], now: number): number | undefined {
  const timeWord = words.length > 0 && timeOf(words.at(-1)!) ? words.at(-1)! : undefined;
  const dayWords = timeWord ? words.slice(0, -1) : words;
  const time = timeWord ? timeOf(timeWord)! : undefined;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (dayWords.length === 0) {
    if (!time) return undefined;
    const at = withTime(today, time);
    return at > now ? at : withTime(addDays(today, 1), time);
  }
  const day = dayOf(dayWords, today);
  if (day) return withTime(day, time ?? { hours: morning, minutes: 0 });
  const whole = time ? dayOf(words, today) : undefined;
  return whole ? withTime(whole, { hours: morning, minutes: 0 }) : undefined;
}

type Time = { hours: number; minutes: number };

function timeOf(word: string): Time | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(word);
  if (!match) return undefined;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (match[3] === "pm" && hours < 12) hours += 12;
  if (match[3] === "am" && hours === 12) hours = 0;
  return hours < 24 && minutes < 60 ? { hours, minutes } : undefined;
}

function dayOf(words: string[], today: Date): Date | undefined {
  const [first, second] = words;
  if (words.length === 1 && first === "today") return today;
  if (words.length === 1 && (first === "tomorrow" || first === "tmrw")) return addDays(today, 1);
  if (words.length === 1) {
    const weekday = days.findIndex((day) => first!.startsWith(day));
    if (weekday >= 0) return addDays(today, ((weekday - today.getDay() + 6) % 7) + 1);
  }
  if (words.length === 2) {
    const month = months.findIndex((name) => first!.startsWith(name) || second!.startsWith(name));
    const date = Number(/^\d{1,2}$/.test(first!) ? first : second);
    if (month < 0 || !Number.isInteger(date) || date < 1 || date > 31) return undefined;
    const day = new Date(today.getFullYear(), month, date);
    if (day.getMonth() !== month) return undefined;
    return day < today ? new Date(today.getFullYear() + 1, month, date) : day;
  }
  return undefined;
}

function addDays(day: Date, count: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + count);
}

function withTime(day: Date, time: Time): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hours, time.minutes).getTime();
}

export function whenLabel(at: number, now: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (new Date(now).toDateString() === date.toDateString()) return time;
  const day = days[date.getDay()]!;
  return `${day[0]!.toUpperCase()}${day.slice(1)} ${date.getDate()} ${months[date.getMonth()]![0]!.toUpperCase()}${months[date.getMonth()]!.slice(1)} ${time}`;
}
