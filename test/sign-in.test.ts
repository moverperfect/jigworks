import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// When the Developer's Access sign-in expires, the page says so and offers to
// sign in again, rather than the Conversation's socket retrying forever (#111).
// Access answers an expired sign-in with a redirect to its login page, which
// the page's requests see as an opaque redirect, and the socket only as a
// closed connection.

type Api = typeof import("../client/src/api");

const answers = {
  accessRedirect: () => ({ type: "opaqueredirect", ok: false, status: 0 }) as unknown as Response,
  notSignedIn: () => Response.json({ error: "Sign in through Cloudflare Access." }, { status: 401 }),
  refused: () => Response.json({ error: "someone@example.com isn't a Developer on this platform." }, { status: 403 }),
  serverError: () => new Response("Internal Server Error", { status: 500 }),
  signedIn: () => Response.json({ email: "developer@example.com" }),
  unreachable: () => {
    throw new TypeError("Failed to fetch");
  },
};

let fetchMock: ReturnType<typeof vi.fn<(input: RequestInfo | URL) => Response>>;
const answerWith = (answer: () => Response) => fetchMock.mockImplementation(answer);

// The signed-out state belongs to the page, so each test loads the API afresh, as a new page would.
let api: Api;
beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => fetchMock(input));
  api = await import("../client/src/api");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const failureOf = async (call: Promise<unknown>) => {
  const error = await call.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(api.ApiError);
  return error as InstanceType<Api["ApiError"]>;
};

describe("an expired sign-in", () => {
  it("is what Access's redirect to its login page means", async () => {
    answerWith(answers.accessRedirect);
    const error = await failureOf(api.listWorkspaces());
    expect(error.signedOut).toBe(true);
    expect(error.message).toBe("Your sign-in has expired.");
  });

  it("is what the platform's own 401 means", async () => {
    answerWith(answers.notSignedIn);
    expect((await failureOf(api.startTurn("w1", "Make it blue"))).signedOut).toBe(true);
  });

  it("is told apart from a refusal, a failure and no connection at all", async () => {
    for (const answer of [answers.refused, answers.serverError, answers.unreachable]) {
      answerWith(answer);
      expect((await failureOf(api.listWorkspaces())).signedOut).toBe(false);
    }
  });
});

describe("the signed-out state, which shows the note", () => {
  it("doesn't show while requests succeed, or fail for other reasons", async () => {
    answerWith(answers.signedIn);
    await api.getMe();
    for (const answer of [answers.refused, answers.serverError, answers.unreachable]) {
      answerWith(answer);
      await failureOf(api.getMe());
    }
    expect(api.isSignedOut()).toBe(false);
  });

  it("shows once any request finds the sign-in expired, and stays until the page reloads", async () => {
    const changed = vi.fn();
    api.onSignedOutChange(changed);
    answerWith(answers.accessRedirect);
    await failureOf(api.listFiles("w1"));
    expect(api.isSignedOut()).toBe(true);
    expect(changed).toHaveBeenCalledOnce();

    answerWith(answers.signedIn);
    await api.getMe();
    expect(api.isSignedOut()).toBe(true);
  });

  it("shows when the Conversation's socket closed because the sign-in expired", async () => {
    answerWith(answers.accessRedirect);
    await api.checkSignIn();
    expect(api.isSignedOut()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/me");
  });

  it("doesn't show when the socket closed for another reason, so it keeps trying to reconnect", async () => {
    for (const answer of [answers.signedIn, answers.serverError, answers.unreachable]) {
      answerWith(answer);
      await api.checkSignIn();
    }
    expect(api.isSignedOut()).toBe(false);
  });

  it("asks the platform only until it finds the sign-in expired", async () => {
    answerWith(answers.notSignedIn);
    await api.checkSignIn();
    await api.checkSignIn();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("the message box's text", () => {
  const key = "jigworks:message:w1";
  const setUp = async (stored: Record<string, string> = {}) => {
    const { keepDraft, readDraft } = await import("../client/src/draft");
    const kept = new Map(Object.entries(stored));
    const storage = () => ({
      getItem: (name: string) => kept.get(name) ?? null,
      setItem: (name: string, text: string) => void kept.set(name, text),
      removeItem: (name: string) => void kept.delete(name),
    });
    const page = new EventTarget();
    let text = readDraft(storage, key);
    const stop = keepDraft(page, storage, key, () => text);
    return {
      kept,
      shown: () => text,
      type: (typed: string) => (text = typed),
      go: (event: "pagehide" | "pageshow") => page.dispatchEvent(new Event(event)),
      stop,
      reload: () => readDraft(storage, key),
    };
  };

  it("is kept for after the reload that signs the Developer in again, and only once", async () => {
    const box = await setUp({ [key]: "Make it blue" });
    expect(box.shown()).toBe("Make it blue");
    expect(box.kept.has(key)).toBe(false);

    box.type("Make it green");
    box.go("pagehide");
    expect(box.reload()).toBe("Make it green");
  });

  it("isn't kept once sent, even when the page came back from the back-forward cache", async () => {
    const box = await setUp();
    box.type("Make it blue");
    box.go("pagehide");
    // Back from the cache: the box still shows the text, and nothing mounts again.
    box.go("pageshow");
    box.type("");
    box.stop();
    expect(box.reload()).toBe("");
  });
});

describe("where the note shows", () => {
  const failureNote = async (status: number, inDialog: boolean) =>
    (await import("../client/src/failureNote")).failureNote(new api.ApiError("", status), inDialog);

  it("is once, above the page, rather than again where a request failed", async () => {
    expect(await failureNote(401, false)).toBeNull();
    expect(await failureNote(500, false)).toBe("message");
  });

  it("is in a modal dialog too, which hides the page's note", async () => {
    expect(await failureNote(401, true)).toBe("sign-in");
    expect(await failureNote(500, true)).toBe("message");
  });
});
