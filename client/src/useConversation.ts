import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import type { ConversationState, MessageMetadata } from "../../src/shared/conversation.ts";
import { conversationBasePath } from "./api";

export type ConversationMessage = UIMessage<MessageMetadata>;

export interface Conversation {
  messages: ConversationMessage[];
  /** The Workspace agent's state, or null until the socket first sends it. */
  state: ConversationState | null;
  /** Whether the socket is open and the platform has sent the state. */
  connected: boolean;
  /** Whether the socket closed and won't reconnect, such as when the sign-in expired. */
  failed: boolean;
  /** Whether a Turn's reply is arriving. */
  streaming: boolean;
}

/**
 * A Workspace's Conversation, on the Agents SDK's own WebSocket protocol. The
 * socket only watches: the history and each Turn's reply arrive on it, but
 * Turns start over HTTP (`startTurn`), and the platform drops anything the
 * socket sends but the stream-resume handshake, so `useAgentChat`'s
 * `sendMessage` and `clearHistory` do nothing.
 */
export function useConversation(id: string): Conversation {
  const agent = useAgent<ConversationState>({
    // The platform routes the socket itself, so `basePath` makes `agent` only a label.
    agent: "workspace",
    basePath: conversationBasePath(id),
  });
  const transcript = useAgentChat<ConversationState, ConversationMessage>({
    agent,
    // The history arrives on the socket, so don't fetch it over HTTP too.
    getInitialMessages: null,
  });

  return {
    messages: transcript.messages,
    state: agent.state ?? null,
    connected: agent.identified,
    failed: agent.connectionError !== null,
    streaming: transcript.isStreaming,
  };
}
