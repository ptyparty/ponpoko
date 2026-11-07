import { describe, expect, test } from "bun:test";
import { parseWhen, whenLabel } from "./when.ts";

const now = new Date(2026, 10, 7, 14, 50).getTime();
const at = (month: number, date: number, hours: number, minutes = 0, year = 2026) => new Date(year, month, date, hours, minutes).getTime();

describe("parseWhen", () => {
  test("reads a span from now", () => {
    expect(parseWhen("30m", now)).toBe(now + 30 * 60_000);
    expect(parseWhen("2h", now)).toBe(now + 2 * 3_600_000);
    expect(parseWhen("2d", now)).toBe(now + 2 * 86_400_000);
  });

  test("reads a time as its next occurrence", () => {
    expect(parseWhen("16:30", now)).toBe(at(10, 7, 16, 30));
    expect(parseWhen("9", now)).toBe(at(10, 8, 9));
    expect(parseWhen("3pm", now)).toBe(at(10, 7, 15));
    expect(parseWhen("12am", now)).toBe(at(10, 8, 0));
  });

  test("reads a day, at 9:00 unless a time follows", () => {
    expect(parseWhen("tomorrow", now)).toBe(at(10, 8, 9));
    expect(parseWhen("tomorrow 14:00", now)).toBe(at(10, 8, 14));
    expect(parseWhen("today 17:00", now)).toBe(at(10, 7, 17));
    expect(parseWhen("mon", now)).toBe(at(10, 9, 9));
    expect(parseWhen("Monday 10:15", now)).toBe(at(10, 9, 10, 15));
    expect(parseWhen("sat", now)).toBe(at(10, 14, 9));
  });

  test("reads a month and date, rolling into next year once it has passed", () => {
    expect(parseWhen("nov 12", now)).toBe(at(10, 12, 9));
    expect(parseWhen("12 nov 13:00", now)).toBe(at(10, 12, 13));
    expect(parseWhen("jan 3", now)).toBe(at(0, 3, 9, 0, 2027));
  });

  test("refuses what it can't read, or what has already passed", () => {
    expect(parseWhen("", now)).toBeUndefined();
    expect(parseWhen("soon", now)).toBeUndefined();
    expect(parseWhen("25:00", now)).toBeUndefined();
    expect(parseWhen("feb 30", now)).toBeUndefined();
    expect(parseWhen("today 9", now)).toBeUndefined();
  });
});

describe("whenLabel", () => {
  test("gives only the time today, and the day otherwise", () => {
    expect(whenLabel(at(10, 7, 16, 30), now)).toBe("16:30");
    expect(whenLabel(at(10, 9, 9), now)).toBe("Mon 9 Nov 09:00");
  });
});
