/**
 * Reads the top-level `time` object of a full npm package document from a
 * stream, without holding the rest of the document in memory.
 */
export async function readPublishTimes(body: ReadableStream<Uint8Array>): Promise<Record<string, string>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const scanner = new Scanner();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (scanner.feed(decoder.decode(value, { stream: true }))) return scanner.publishTimes();
    }
    if (scanner.feed(decoder.decode())) return scanner.publishTimes();
    scanner.end();
    return {};
  } finally {
    // Stops the download once `time` has closed or the document proved bad.
    // After the stream has ended this does nothing.
    await reader.cancel().catch(() => {});
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/**
 * Follows a JSON document's strings and nesting one decoded chunk at a time,
 * and keeps only the text of the root object's `time` value. It checks the
 * document's shape, not its full grammar: `JSON.parse` checks the part it keeps.
 */
class Scanner {
  /** Objects and arrays open at this point; 1 directly inside the root object. */
  private depth = 0;
  private started = false;
  private inString = false;
  /** The last chunk ended on a backslash in a string, so the next one starts with the escaped character. */
  private escaped = false;
  /** The root object's next string is a key. */
  private expectKey = false;
  /** Reading one of the root object's keys, whose raw text from earlier chunks is `key`. */
  private inKey = false;
  private key = "";
  /** The last root key was `time` and its value hasn't started. */
  private atTime = false;
  /** The `time` object's text so far, once it has started. */
  private time: string[] | undefined;

  /** Scans the next piece of the document. True once the `time` object has closed. */
  feed(text: string): boolean {
    const length = text.length;
    if (length === 0) return false;
    let { depth, inString, expectKey, inKey, atTime } = this;
    let i = 0;
    if (this.escaped) {
      this.escaped = false;
      i = 1;
    }
    let keyStart = 0;
    let timeStart = 0;
    for (; i < length; i++) {
      const char = text.charCodeAt(i);
      if (inString) {
        if (char === BACKSLASH) {
          // Skip the escaped character. The hex digits of a `\uXXXX` escape
          // can't end the string, so they need no special case.
          if (++i === length) this.escaped = true;
        } else if (char === QUOTE) {
          inString = false;
          if (inKey) {
            inKey = false;
            atTime = this.key + text.slice(keyStart, i) === "time";
            this.key = "";
          }
        }
        continue;
      }
      if (depth === 0) {
        if (char === OPEN_BRACE && !this.started) {
          this.started = true;
          depth = 1;
          expectKey = true;
        } else if (!isWhitespace(char)) {
          throw new SyntaxError(
            this.started
              ? "The package document has more text after its closing brace"
              : "The package document isn't a JSON object",
          );
        }
        continue;
      }
      switch (char) {
        case QUOTE:
          inString = true;
          if (depth === 1) {
            if (expectKey) {
              expectKey = false;
              inKey = true;
              keyStart = i + 1;
            } else {
              atTime = false;
            }
          }
          break;
        case OPEN_BRACE:
        case OPEN_BRACKET:
          if (depth === 1) {
            if (atTime && char === OPEN_BRACE) {
              this.time = [];
              timeStart = i;
            }
            atTime = false;
          }
          depth++;
          break;
        case CLOSE_BRACE:
        case CLOSE_BRACKET:
          depth--;
          if (depth === 1 && this.time) {
            this.time.push(text.slice(timeStart, i + 1));
            return true;
          }
          break;
        case COMMA:
          if (depth === 1) {
            expectKey = true;
            atTime = false;
          }
          break;
      }
    }
    if (inKey) this.key += text.slice(keyStart);
    this.time?.push(text.slice(timeStart));
    this.depth = depth;
    this.inString = inString;
    this.expectKey = expectKey;
    this.inKey = inKey;
    this.atTime = atTime;
    return false;
  }

  /** The `time` object's entries with string values, once `feed` has returned true. */
  publishTimes(): Record<string, string> {
    const times = JSON.parse(this.time!.join("")) as Record<string, unknown>;
    // An unpublished package's `time` also holds an `unpublished` object.
    return Object.fromEntries(
      Object.entries(times).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  /** Throws unless the document so far is a whole object. */
  end(): void {
    if (!this.started) throw new SyntaxError("The package document isn't a JSON object");
    if (this.depth > 0) throw new SyntaxError("The package document ended before its closing brace");
  }
}

function isWhitespace(char: number): boolean {
  return char === 0x20 || char === 0x0a || char === 0x0d || char === 0x09;
}
