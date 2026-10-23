import { exports } from "cloudflare:workers";
import type { UIMessage } from "ai";
import { expect } from "vitest";
import type { ConversationState, LastTurn, MessageMetadata } from "../../src/shared/conversation";
import { accessToken, testAccess } from "./access";
import { call } from "./api";

// The Conversation as the Workspace page sees it: a socket that's sent every
// frame of every Turn, and the HTTP calls that start Turns.

export interface Frame {
  type: string;
  state?: ConversationState;
  messages?: UIMessage<MessageMetadata>[];
  /** Set on the Conversation a socket is sent when it connects. */
  connect?: boolean;
}

export interface Conversation {
  frames: Frame[];
  /** The first frame at or after index `from` that matches. */
  next(match: (frame: Frame) => boolean, from?: number): Promise<Frame>;
  send(frame: object): void;
  close(): void;
}

/** Opens the Workspace's Conversation socket, as the page does. */
export async function connect(id: string, headers: Record<string, string> = {}): Promise<Conversation> {
  const response = await upgrade(id, headers);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frames: Frame[] = [];
  const listeners = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as Frame);
    for (const listener of listeners) listener();
  });
  return {
    frames,
    next(match, from = 0) {
      return new Promise((resolve, reject) => {
        const look = () => {
          const found = frames.slice(from).find(match);
          if (!found) return;
          listeners.delete(look);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          listeners.delete(look);
          reject(new Error(`No matching frame in: ${frames.map((frame) => frame.type).join(", ")}`));
        }, 60_000);
        listeners.add(look);
        look();
      });
    },
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
}

/** The upgrade request the page sends, with any headers overridden. */
export async function upgrade(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(
    new Request(`${testAccess.origin}/api/workspaces/${id}/conversation`, {
      headers: {
        Upgrade: "websocket",
        "Cf-Access-Jwt-Assertion": await accessToken({ email: testAccess.developer }),
        Origin: testAccess.origin,
        "Sec-Fetch-Site": "same-origin",
        ...headers,
      },
    }),
  );
}

/** Starts a Turn with the Developer's message. */
export function startTurn(id: string, message: string): Promise<Response> {
  return call(`/api/workspaces/${id}/turns`, { method: "POST", body: { message } });
}

/** Runs a Turn and waits for it to end, Check and retries included. */
export async function runTurn(id: string, conversation: Conversation, message: string): Promise<LastTurn> {
  const from = conversation.frames.length;
  const response = await startTurn(id, message);
  expect(response.status).toBe(202);
  return turnEnd(conversation, from);
}

/** How the first Turn to start at or after frame `from` ended. */
export async function turnEnd(conversation: Conversation, from: number): Promise<LastTurn> {
  const started = await turnStart(conversation, from);
  const ended = await conversation.next(
    (frame) => frame.type === "cf_agent_state" && frame.state?.turn === null,
    conversation.frames.indexOf(started),
  );
  return ended.state!.lastTurn!;
}

/** The state frame saying a Turn started, at or after frame `from`. */
export function turnStart(conversation: Conversation, from: number): Promise<Frame> {
  return conversation.next((frame) => frame.type === "cf_agent_state" && Boolean(frame.state?.turn), from);
}

/** The Conversation as a new visit sees it: the history sent when a socket connects. */
export async function history(id: string): Promise<UIMessage<MessageMetadata>[]> {
  const conversation = await connect(id);
  const frame = await conversation.next((frame) => frame.type === "cf_agent_chat_messages");
  conversation.close();
  return frame.messages!;
}

/** All the text an assistant message streamed. */
export function textOf(message: UIMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}
