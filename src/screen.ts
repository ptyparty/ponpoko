export type Key = { name: string; text?: string };

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < data.length) {
    const rest = data.slice(index);
    const arrow = /^\x1b\[([ABCD])/.exec(rest);
    if (arrow) {
      keys.push({ name: { A: "up", B: "down", C: "right", D: "left" }[arrow[1] as "A"] });
      index += 3;
      continue;
    }
    const char = data[index]!;
    index++;
    if (char === "\x1b") keys.push({ name: "escape" });
    else if (char === "\r" || char === "\n") keys.push({ name: "return" });
    else if (char === "\x7f" || char === "\b") keys.push({ name: "backspace" });
    else if (char === "\x03") keys.push({ name: "ctrl+c" });
    else if (char === "\t") keys.push({ name: "tab" });
    else if (char >= " ") keys.push({ name: char, text: char });
  }
  return keys;
}

const palette = {
  text: "#e8ebf2",
  muted: "#9298ab",
  faint: "#565e72",
  you: "#ffc45e",
  agent: "#8fb0ff",
  wait: "#c89dff",
  warn: "#ffa863",
  error: "#ff6b6b",
  ground: "#0f1117",
  surface: "#181b24",
  raised: "#282e3d",
  selection: "#2c3a68",
};

const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(";");
const fg = (hex: string) => (text: string) => `\x1b[38;2;${rgb(hex)}m${text}\x1b[39m`;
const bg = (hex: string) => (text: string) => `\x1b[48;2;${rgb(hex)}m${text.replaceAll("\x1b[49m", `\x1b[48;2;${rgb(hex)}m`)}\x1b[49m`;

export const style = {
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  dim: fg(palette.muted),
  text: fg(palette.text),
  muted: fg(palette.muted),
  faint: fg(palette.faint),
  amber: fg(palette.you),
  you: fg(palette.you),
  cyan: fg(palette.agent),
  agent: fg(palette.agent),
  accent: fg(palette.agent),
  magenta: fg(palette.wait),
  wait: fg(palette.wait),
  warn: fg(palette.warn),
  red: fg(palette.error),
  reverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
  surface: bg(palette.surface),
  raised: bg(palette.raised),
  selected: bg(palette.selection),
  key: (key: string) => bg(palette.muted)(fg(palette.ground)(` ${key} `)),
  enter: (key: string) => bg(palette.agent)(fg(palette.ground)(`\x1b[1m ${key} \x1b[22m`)),
};

export function visible(text: string): number {
  return [...text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")].length;
}

export type Part = string | [string, ((text: string) => string)?];

export function cells(parts: Part[], width: number): string {
  let left = width;
  let out = "";
  for (const part of parts) {
    const [text, paint] = typeof part === "string" ? [part, undefined] : part;
    if (left <= 0) break;
    if (text.includes("\x1b")) {
      left -= visible(text);
      out += paint ? paint(text) : text;
      continue;
    }
    const chars = [...text];
    const shown = chars.length > left ? `${chars.slice(0, Math.max(0, left - 1)).join("")}…` : text;
    left -= [...shown].length;
    out += paint ? paint(shown) : shown;
  }
  return out + " ".repeat(Math.max(0, left));
}

export function keyLine(keys: [string, string][]): string {
  return ` ${keys.map(([key, label]) => `${style.key(key)} ${style.muted(label)}`).join("   ")}`;
}

export type Screen = { width: number; height: number; draw: (lines: string[]) => void; close: () => void };

export function openScreen(onKey: (key: Key) => void, onResize: () => void): Screen {
  const out = process.stdout;
  out.write("\x1b[?1049h\x1b[?25l");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const listener = (data: string) => {
    for (const key of parseKeys(data)) onKey(key);
  };
  process.stdin.on("data", listener);
  out.on("resize", onResize);
  const screen: Screen = {
    get width() {
      return out.columns ?? 100;
    },
    get height() {
      return out.rows ?? 30;
    },
    draw: (lines) => {
      out.write(`\x1b[H${lines.slice(0, screen.height).map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
    },
    close: () => {
      process.stdin.off("data", listener);
      out.off("resize", onResize);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      out.write("\x1b[?25h\x1b[?1049l");
    },
  };
  return screen;
}
