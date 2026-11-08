import { describe, expect, test } from "bun:test";
import { shortcutTitle, storyNumber } from "./shortcut.ts";

describe("Shortcut titles", () => {
  test("read a story number only from a whole sc- name", () => {
    expect(storyNumber("sc-1236")).toBe(1236);
    expect(storyNumber("SC-1")).toBe(1);
    expect(storyNumber("sc-1236 fixups")).toBeUndefined();
    expect(storyNumber("ponpoko")).toBeUndefined();
  });

  test("look nothing up for other names, and fail without a token so the bridge tries again", async () => {
    expect(await shortcutTitle("ponpoko", "")).toBeUndefined();
    await expect(shortcutTitle("sc-1", "")).rejects.toThrow("SHORTCUT_TOKEN isn't set");
  });
});
