import { describe, expect, it } from "vitest";
import styles from "../client/src/styles.css?raw";

// The page's colours meet WCAG AA in light and dark mode: 4.5:1 for text and
// 3:1 for the edges and marks that show a control or a state (WCAG 1.4.3 and
// 1.4.11). Read from the tokens in styles.css, so a changed token is checked.

/** The `--name: #hex` tokens set on `:root` in the first block after `marker`. */
function tokens(marker: string): Record<string, string> {
  const start = styles.indexOf(":root", styles.indexOf(marker));
  const body = styles.slice(styles.indexOf("{", start) + 1, styles.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, name, hex]) => [name, hex]));
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const light = tokens(":root");
const modes = { light, dark: { ...light, ...tokens("(prefers-color-scheme: dark)") } };

const text = 4.5;
const mark = 3;
// Each colour, what it sits on, and the contrast it needs. The Mat is `background` and Paper is `surface`.
const pairs: [string, string, number][] = [
  ...["text", "muted", "primary", "danger"].flatMap((name): [string, string, number][] => [
    [name, "background", text],
    [name, "surface", text],
  ]),
  ...["warning", "code-keyword", "code-string", "code-literal", "code-comment", "code-type", "code-function"].map(
    (name): [string, string, number] => [name, "surface", text],
  ),
  ["on-primary", "primary", text],
  ["on-danger", "danger", text],
  // A field's edge, and the brackets in each colour.
  ["border-strong", "surface", mark],
  ["chalk", "background", mark],
];

describe.each(Object.entries(modes))("the %s colours", (_mode, colour) => {
  it.each(pairs)("%s on %s reaches %d:1", (name, ground, minimum) => {
    expect(contrast(colour[name]!, colour[ground]!)).toBeGreaterThanOrEqual(minimum);
  });
});
