import type { SyntaxNode } from "@lezer/common";
import { GFM, parser } from "@lezer/markdown";
// In the page, this decodes through a detached element's innerHTML, which is
// 1 kB rather than a 37 kB table. decodeEscapes hands it only `[A-Za-z][A-Za-z\d]*`
// names, so nothing from a reply can become markup. The tests get the table.
import { decodeNamedCharacterReference } from "decode-named-character-reference";

/** Text, or an element for the page to make. */
export type MarkdownNode = string | MarkdownElement;

export interface MarkdownElement {
  tag:
    | "p"
    | "h3"
    | "h4"
    | "h5"
    | "h6"
    | "blockquote"
    | "ul"
    | "ol"
    | "li"
    | "hr"
    | "br"
    | "pre"
    | "div"
    | "table"
    | "thead"
    | "tbody"
    | "tr"
    | "th"
    | "td"
    | "input"
    | "em"
    | "strong"
    | "del"
    | "code"
    | "a";
  attributes?: Attributes;
  children: MarkdownNode[];
}

/** The only attributes an element can have. */
export interface Attributes {
  className?: string;
  href?: string;
  target?: "_blank";
  rel?: "noopener noreferrer";
  title?: string;
  start?: number;
  type?: "checkbox";
  disabled?: true;
  checked?: boolean;
  style?: { textAlign: Alignment };
}

type Alignment = "left" | "center" | "right";

/** Where a link goes, before it's checked. */
interface Destination {
  href: string;
  title?: string;
}

const markdown = parser.configure(GFM);

/** What a node's children are wrapped in, for nodes that only wrap their content. */
const inlineTags: Record<string, MarkdownElement["tag"]> = {
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "del",
};

/** Delimiters that the elements around them stand for. */
const marks = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark", "QuoteMark", "HeaderMark", "TaskMarker"]);

/** The only links kept. Anything else, relative links included, could run script or reach the platform. */
const keptProtocols = new Set(["http:", "https:", "mailto:"]);

/** A backslash escape, or a character reference CommonMark recognises. */
const escapeOrReference = /\\([!-/:-@[-`{-~])|&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]*);/g;

/** The Agent's Markdown as elements, `streaming` while more of it is still arriving. */
export function renderMarkdown(text: string, streaming = false): MarkdownNode[] {
  const tree = markdown.parse(text);
  const source = new Source(text, streaming);
  tree.iterate({
    enter: (node) => {
      if (node.name === "LinkReference") source.define(node.node);
    },
  });
  return blocks(source, tree.topNode);
}

/** The Markdown's text, and the link reference definitions in it. */
class Source {
  readonly #references = new Map<string, Destination>();

  constructor(
    readonly text: string,
    readonly streaming: boolean,
  ) {}

  slice(from: number, to: number): string {
    return this.text.slice(from, to);
  }

  define(node: SyntaxNode) {
    const label = node.getChild("LinkLabel");
    const key = label && normaliseLabel(this.slice(label.from + 1, label.to - 1));
    // The first definition of a label wins.
    if (key && !this.#references.has(key)) this.#references.set(key, linkDestination(this, node));
  }

  reference(label: string): Destination | undefined {
    return this.#references.get(normaliseLabel(label));
  }
}

/** Labels match ignoring case and runs of whitespace (CommonMark). Lower then upper case folds case as CommonMark's reference parser does. */
const normaliseLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();

function children(node: SyntaxNode): SyntaxNode[] {
  const list: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) list.push(child);
  return list;
}

/** A link's or definition's URL and title, after `from`: a link's text can have bare URLs in it. */
function linkDestination(source: Source, node: SyntaxNode, from = node.from): Destination {
  const after = children(node).filter((child) => child.from >= from);
  const url = after.find((child) => child.name === "URL");
  const title = after.find((child) => child.name === "LinkTitle");
  let href = url ? source.slice(url.from, url.to) : "";
  if (href.startsWith("<")) href = href.slice(1, -1);
  return {
    href: decodeEscapes(href),
    ...(title && { title: decodeEscapes(source.slice(title.from + 1, title.to - 1)) }),
  };
}

function blocks(source: Source, parent: SyntaxNode): MarkdownNode[] {
  return children(parent).flatMap((node): MarkdownNode[] => {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
    if (heading) {
      // The panel's heading is an <h2>, so the reply's start at <h3>.
      const tag = `h${Math.min(Number(heading[1]) + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
      return [{ tag, children: inline(source, node) }];
    }
    switch (node.name) {
      case "Paragraph":
        return [{ tag: "p", children: inline(source, node) }];
      case "Blockquote":
        return [{ tag: "blockquote", children: blocks(source, node) }];
      case "BulletList":
        return [{ tag: "ul", children: blocks(source, node) }];
      case "OrderedList": {
        const mark = node.firstChild?.getChild("ListMark");
        const start = mark ? parseInt(source.slice(mark.from, mark.to), 10) : 1;
        return [{ tag: "ol", ...(start !== 1 && { attributes: { start } }), children: blocks(source, node) }];
      }
      case "ListItem": {
        const task = node.getChild("Task") !== null;
        return [{ tag: "li", ...(task && { attributes: { className: "markdown-task" } }), children: blocks(source, node) }];
      }
      case "Task": {
        const marker = node.getChild("TaskMarker")!;
        const checked = source.slice(marker.from, marker.to) !== "[ ]";
        const box: MarkdownElement = { tag: "input", attributes: { type: "checkbox", disabled: true, checked }, children: [] };
        return [{ tag: "p", children: [box, ...inline(source, node, marker.to)] }];
      }
      case "FencedCode":
      case "CodeBlock":
        return [{ tag: "pre", children: [{ tag: "code", children: [codeBlock(source, node)] }] }];
      case "HorizontalRule":
        return [{ tag: "hr", children: [] }];
      case "Table":
        return [{ tag: "div", attributes: { className: "markdown-table" }, children: [table(source, node)] }];
      case "HTMLBlock":
      case "CommentBlock":
      case "ProcessingInstructionBlock":
        // Shown as typed, line breaks and all.
        return [{ tag: "p", attributes: { className: "markdown-html" }, children: [textWithoutChildren(source, node)] }];
      case "QuoteMark":
      case "ListMark":
      case "LinkReference":
        return [];
      default:
        return [{ tag: "p", children: [source.slice(node.from, node.to)] }];
    }
  });
}

/** A node's inline content from `from` to `to`, with the text between its children. */
function inline(source: Source, parent: SyntaxNode, from = parent.from, to = parent.to, inLink = false): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let at = from;
  for (const node of children(parent)) {
    if (node.from < from || node.to > to) continue;
    if (node.from > at) nodes.push(source.slice(at, node.from));
    nodes.push(...inlineNode(source, node, inLink));
    at = node.to;
  }
  if (to > at) nodes.push(source.slice(at, to));
  return nodes;
}

function inlineNode(source: Source, node: SyntaxNode, inLink: boolean): MarkdownNode[] {
  const tag = inlineTags[node.name];
  if (tag) return [{ tag, children: inline(source, node, node.from, node.to, inLink) }];
  if (marks.has(node.name)) return [];
  switch (node.name) {
    case "InlineCode":
      return [{ tag: "code", children: [codeSpan(source, node)] }];
    case "Link":
    case "Image":
      return link(source, node, inLink);
    case "Autolink":
    case "URL": {
      const url = node.name === "URL" ? node : node.getChild("URL")!;
      const text = source.slice(url.from, url.to);
      return inLink ? [text] : anchor({ href: autolinkHref(text) }, [text]);
    }
    case "Entity":
      return [decodeEscapes(source.slice(node.from, node.to))];
    case "Escape":
      return [source.slice(node.from + 1, node.to)];
    case "HardBreak":
      return [{ tag: "br", children: [] }];
    default:
      return [source.slice(node.from, node.to)];
  }
}

/**
 * A link, or its text when its destination isn't kept, or the source when its
 * reference isn't defined. An image is a link to it, so it never loads,
 * labelled with its alt text or else its URL.
 */
function link(source: Source, node: SyntaxNode, inLink: boolean): MarkdownNode[] {
  const [open, close, after] = node.getChildren("LinkMark");
  const text = inline(source, node, open!.to, close!.from, true);
  let destination: Destination | undefined;
  if (after && source.slice(after.from, after.to) === "(") destination = linkDestination(source, node, after.to);
  else {
    // `[text][label]`, or `[label][]` and `[label]`, which use the text as the label.
    const label = node.getChild("LinkLabel");
    destination = source.reference(
      label && label.to - label.from > 2 ? source.slice(label.from + 1, label.to - 1) : source.slice(open!.to, close!.from),
    );
    if (!destination) return [source.slice(node.from, open!.to), ...text, source.slice(close!.from, node.to)];
  }
  if (inLink) return text;
  const unlabelled = text.every((part) => typeof part === "string" && !part.trim());
  return anchor(destination, node.name === "Image" && unlabelled ? [destination.href] : text);
}

/** Where an autolink or a bare URL goes: `www.` addresses are http (GFM), and email addresses mailto. */
const autolinkHref = (text: string) =>
  /^[A-Za-z][A-Za-z\d+.-]{1,31}:/.test(text) ? text : text.startsWith("www.") ? `http://${text}` : `mailto:${text}`;

/** A link to a kept destination, opening in a new tab, or else just its text. */
function anchor(destination: Destination, children: MarkdownNode[]): MarkdownNode[] {
  const href = safeHref(destination.href);
  if (href === null) return children;
  return [
    {
      tag: "a",
      attributes: { href, target: "_blank", rel: "noopener noreferrer", ...(destination.title !== undefined && { title: destination.title }) },
      children,
    },
  ];
}

/**
 * The URL a link may go to, as the browser will read it, or null if it must stay
 * text. The browser's own parser drops tabs and spaces and ignores case, so a
 * scheme can't hide from this check.
 */
function safeHref(href: string): string | null {
  // Not URL.parse, which is newer than the browsers the page is built for.
  try {
    const url = new URL(href);
    return keptProtocols.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Text with its backslash escapes and character references decoded. */
function decodeEscapes(text: string): string {
  return text.replace(escapeOrReference, (match, escaped: string | undefined, reference: string | undefined) => {
    if (escaped) return escaped;
    if (!reference!.startsWith("#")) return decodeNamedCharacterReference(reference!) || match;
    const code = /^#x/i.test(reference!) ? parseInt(reference!.slice(2), 16) : parseInt(reference!.slice(1), 10);
    // CommonMark replaces U+0000, and anything that isn't a Unicode scalar value, with U+FFFD.
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(code);
  });
}

function table(source: Source, node: SyntaxNode): MarkdownElement {
  // The delimiter row, such as `|:--|--:|`, sets each column's alignment.
  const delimiter = node.getChild("TableDelimiter")!;
  const alignments = source
    .slice(delimiter.from, delimiter.to)
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((column): Alignment | undefined => {
      const left = column.trim().startsWith(":");
      const right = column.trim().endsWith(":");
      return left && right ? "center" : right ? "right" : left ? "left" : undefined;
    });
  // Every row has the header's columns: missing cells are empty and extra ones are left out (GFM).
  const row = (node: SyntaxNode, tag: "th" | "td"): MarkdownElement => {
    const cells = tableCells(node);
    return {
      tag: "tr",
      children: alignments.map((textAlign, index) => {
        const cell = cells[index];
        return { tag, ...(textAlign && { attributes: { style: { textAlign } } }), children: cell ? inline(source, cell) : [] };
      }),
    };
  };
  const rows = node.getChildren("TableRow");
  return {
    tag: "table",
    children: [
      { tag: "thead", children: [row(node.getChild("TableHeader")!, "th")] },
      ...(rows.length > 0 ? [{ tag: "tbody" as const, children: rows.map((body) => row(body, "td")) }] : []),
    ],
  };
}

/** A row's cells, null where one is empty: lezer has no node for an empty cell, only the `|`s around it. */
function tableCells(row: SyntaxNode): (SyntaxNode | null)[] {
  const cells: (SyntaxNode | null)[] = [null];
  for (const child of children(row)) {
    if (child.name === "TableDelimiter") cells.push(null);
    else cells[cells.length - 1] = child;
  }
  // A `|` at either end of the row doesn't start or end a cell.
  if (row.firstChild?.name === "TableDelimiter") cells.shift();
  if (row.lastChild?.name === "TableDelimiter") cells.pop();
  return cells;
}

/** A code block's text, without the indentation and `>`s of the blocks around it. */
function codeBlock(source: Source, node: SyntaxNode): string {
  const code = node
    .getChildren("CodeText")
    .map((text) => source.slice(text.from, text.to))
    .join("");
  const fences = node.getChildren("CodeMark");
  if (!source.streaming || node.name !== "FencedCode" || fences.length > 1) return code;
  // A reply's closing fence can arrive a character at a time, so while it
  // streams, an unclosed block leaves out a last line that could be one, and
  // the block doesn't change when the fence is complete.
  const fence = source.slice(fences[0]!.from, fences[0]!.from + 1);
  return code.replace(new RegExp(`(^|\n) {0,3}\\${fence}*$`), "");
}

/** A code span's text: line breaks become spaces, and one space each side goes when both are there (CommonMark). */
function codeSpan(source: Source, node: SyntaxNode): string {
  const [open, close] = node.getChildren("CodeMark");
  const code = textWithoutChildren(source, node, open!.to, close!.from).replace(/\n/g, " ");
  return /^ .* $/.test(code) && code.trim() ? code.slice(1, -1) : code;
}

/** The source from `from` to `to`, leaving out the parent's children, such as a block quote's `>`s. */
function textWithoutChildren(source: Source, parent: SyntaxNode, from = parent.from, to = parent.to): string {
  let text = "";
  let at = from;
  for (const node of children(parent)) {
    if (node.to <= from || node.from >= to) continue;
    text += source.slice(at, node.from);
    at = node.to;
  }
  return text + source.slice(at, to);
}
