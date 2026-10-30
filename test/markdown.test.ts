import { describe, expect, it } from "vitest";
import { renderMarkdown, type MarkdownNode } from "../client/src/markdown";

// The Agent's replies render as Markdown in the Conversation panel. These
// tests read renderMarkdown's elements back as HTML, escaping every string, so
// anything that would reach the page as markup shows up here as an element.

const attribute = (name: string, value: unknown): string => {
  if (value === false) return "";
  if (value === true) return ` ${name}`;
  if (name === "style") return ` style="text-align: ${(value as { textAlign: string }).textAlign}"`;
  return ` ${name === "className" ? "class" : name}="${escape(String(value))}"`;
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const html = (nodes: MarkdownNode[]): string =>
  nodes
    .map((node) => {
      if (typeof node === "string") return escape(node);
      const attributes = Object.entries(node.attributes ?? {})
        .map(([name, value]) => attribute(name, value))
        .join("");
      if (["br", "hr", "input"].includes(node.tag)) return `<${node.tag}${attributes}>`;
      return `<${node.tag}${attributes}>${html(node.children)}</${node.tag}>`;
    })
    .join("");

const render = (text: string, streaming = false) => html(renderMarkdown(text, streaming));

describe("renderMarkdown", () => {
  it("renders paragraphs with emphasis, strong emphasis, strikethrough and inline code", () => {
    expect(render("Some *em*, **strong**, ~~gone~~ and `code`.\n\nA second\nparagraph.")).toBe(
      "<p>Some <em>em</em>, <strong>strong</strong>, <del>gone</del> and <code>code</code>.</p><p>A second\nparagraph.</p>",
    );
  });

  it("puts headings below the panel's own <h2>", () => {
    expect(render("# One\n## Two\n### Three ###\n#### Four\n##### Five\n###### *Six*\n\nSetext one\n===\n\nSetext two\n---")).toBe(
      "<h3> One</h3><h4> Two</h4><h5> Three </h5><h6> Four</h6><h6> Five</h6><h6> <em>Six</em></h6><h3>Setext one\n</h3><h4>Setext two\n</h4>",
    );
  });

  it("renders lists, nested lists, task lists with boxes that can't be ticked, and rules", () => {
    expect(render("- a\n- b\n  - nested\n\n3. three\n4. four\n\n- [ ] todo\n- [x] *done*\n\n1. one\n\n---")).toBe(
      "<ul><li><p>a</p></li><li><p>b</p><ul><li><p>nested</p></li></ul></li></ul>" +
        '<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>' +
        '<ul><li class="markdown-task"><p><input type="checkbox" disabled> todo</p></li>' +
        '<li class="markdown-task"><p><input type="checkbox" disabled checked> <em>done</em></p></li></ul>' +
        "<ol><li><p>one</p></li></ol><hr>",
    );
  });

  it("renders fenced and indented code blocks as they were typed", () => {
    expect(render("```js\nconst a = 1;\n  <b>indented</b>\n```\n\n    one\n\n      two\n\n> ```\n> quoted\n> ```\n\n- item\n\n  ~~~\n  in a list\n    nested\n  ~~~")).toBe(
      "<pre><code>const a = 1;\n  &lt;b&gt;indented&lt;/b&gt;</code></pre><pre><code>one\n\n  two</code></pre>" +
        "<blockquote><pre><code>quoted</code></pre></blockquote>" +
        "<ul><li><p>item</p><pre><code>in a list\n  nested</code></pre></li></ul>",
    );
  });

  it("renders an unclosed code block to the end of a reply, not changing as its closing fence arrives", () => {
    const closed = "<p>Here:</p><pre><code>line one\nline two</code></pre>";
    for (const streamed of ["", "\n", "\n`", "\n``", "\n```"]) {
      expect(render(`Here:\n\n\`\`\`ts\nline one\nline two${streamed}`, true)).toBe(closed);
    }
    expect(render("~~~\nline\n``", true)).toBe("<pre><code>line\n``</code></pre>");
  });

  it("keeps the last line of an unclosed code block once the reply has finished", () => {
    expect(render("```\nline\n``")).toBe("<pre><code>line\n``</code></pre>");
    expect(render("```\n`")).toBe("<pre><code>`</code></pre>");
  });

  it("renders tables in a block that scrolls, with their alignment, and each row as wide as the header", () => {
    const cell = (tag: string, align: string, content = "") => `<${tag} style="text-align: ${align}">${content}</${tag}>`;
    expect(render("| a | b | c |\n|:--|:-:|--:|\n| *1* |  | 3 | extra |\n| 4 \\| x |\n\nAfter")).toBe(
      '<div class="markdown-table"><table>' +
        `<thead><tr>${cell("th", "left", "a")}${cell("th", "center", "b")}${cell("th", "right", "c")}</tr></thead>` +
        `<tbody><tr>${cell("td", "left", "<em>1</em>")}${cell("td", "center")}${cell("td", "right", "3")}</tr>` +
        `<tr>${cell("td", "left", "4 | x")}${cell("td", "center")}${cell("td", "right")}</tr></tbody>` +
        "</table></div><p>After</p>",
    );
    expect(render("a | b\n--|--")).toBe('<div class="markdown-table"><table><thead><tr><th>a</th><th>b</th></tr></thead></table></div>');
  });

  it("shows raw HTML as its source, keeping an HTML block's line breaks", () => {
    expect(
      render(
        "<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)> and <!-- hidden --> <b>bold</b>.\n\n<div>\n  block\n</div>\n\n<!--\ncomment\n-->",
      ),
    ).toBe(
      '<p class="markdown-html">&lt;script&gt;alert(1)&lt;/script&gt;</p>' +
        "<p>Text &lt;img src=x onerror=alert(1)&gt; and &lt;!-- hidden --&gt; &lt;b&gt;bold&lt;/b&gt;.</p>" +
        '<p class="markdown-html">&lt;div&gt;\n  block\n&lt;/div&gt;</p><p class="markdown-html">&lt;!--\ncomment\n--&gt;</p>',
    );
  });

  it("breaks lines only where CommonMark has a hard break", () => {
    expect(render("soft\nbreak, hard  \nbreak and\\\nanother")).toBe("<p>soft\nbreak, hard<br>break and<br>another</p>");
  });

  it("resolves character references and backslash escapes as CommonMark does", () => {
    expect(render("&amp; &copy; &#169; &#x1F600; &#0; &#12345678; &nosuch; &notit; \\*not em\\*")).toBe(
      "<p>&amp; © © 😀 \uFFFD &amp;#12345678; &amp;nosuch; &amp;notit; *not em*</p>",
    );
  });

  describe("links", () => {
    const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

    it("keeps http, https and mailto links, whatever their case, opening in a new tab", () => {
      expect(render("[a](http://example.com/x) [e](HTTPS://example.com) [f](mailto:x@example.com)")).toBe(
        `<p>${link("http://example.com/x", "a")} ${link("https://example.com/", "e")} ${link("mailto:x@example.com", "f")}</p>`,
      );
    });

    it("shows any other link as its text", () => {
      expect(
        render(
          "[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](data:text/html,x) [d](/relative) [g](//example.com) [h](#top) [i]()",
        ),
      ).toBe("<p>a b c d g h i</p>");
    });

    it("checks the address the browser would follow, after escapes, entities, tabs and spaces", () => {
      expect(render("[a](&#106;avascript:alert(1)) [b](java&#9;script:alert(1)) [c](<  javascript:alert(1)>)")).toBe(
        "<p>a b c</p>",
      );
    });

    it("resolves reference links, and shows ones with no definition as they were typed", () => {
      expect(
        render("[full][Ref] [ref][] [REF] [*none*] [x][none]\n\n> [ref]:   https://example.com/r\n\n[ref]: https://example.com/second"),
      ).toBe(
        `<p>${link("https://example.com/r", "full")} ${link("https://example.com/r", "ref")} ${link("https://example.com/r", "REF")} [<em>none</em>] [x][none]</p><blockquote></blockquote>`,
      );
    });

    it("links autolinks and bare URLs, and shows the rest as text", () => {
      expect(
        render(
          "<https://example.com/a> <javascript:alert(1)> <x@example.com> www.example.com/b https://example.com/c?d. y@example.com xmpp:z@example.com",
        ),
      ).toBe(
        `<p>${link("https://example.com/a", "https://example.com/a")} javascript:alert(1) ${link("mailto:x@example.com", "x@example.com")} ` +
          `${link("http://www.example.com/b", "www.example.com/b")} ${link("https://example.com/c?d", "https://example.com/c?d")}. ` +
          `${link("mailto:y@example.com", "y@example.com")} xmpp:z@example.com</p>`,
      );
    });

    it("never puts a link inside a link", () => {
      expect(render("[see https://example.com/a and <https://example.com/b>](https://example.com/c)")).toBe(
        `<p>${link("https://example.com/c", "see https://example.com/a and https://example.com/b")}</p>`,
      );
    });

    it("shows an image as a link to it, labelled with its alt text, so it never loads", () => {
      expect(
        render(
          "![alt](https://example.com/a.png) ![](https://example.com/b.png) ![bad](javascript:alert(1)) ![ref][r] ![none][nope]\n\n" +
            "[![inner](https://example.com/c.png)](https://example.com/d)\n\n[r]: https://example.com/r.png",
        ),
      ).toBe(
        `<p>${link("https://example.com/a.png", "alt")} ${link("https://example.com/b.png", "https://example.com/b.png")} bad ` +
          `${link("https://example.com/r.png", "ref")} ![none][nope]</p><p>${link("https://example.com/d", "inner")}</p>`,
      );
    });

    it("keeps a link's title", () => {
      expect(render('[a](https://example.com "The &amp; title")')).toBe(
        `<p><a href="https://example.com/" target="_blank" rel="noopener noreferrer" title="The &amp; title">a</a></p>`,
      );
    });
  });
});
