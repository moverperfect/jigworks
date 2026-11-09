import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import type { ConversationState, MessageMetadata } from "../../src/shared/conversation.ts";
import { checkSignIn, conversationBasePath } from "./api";
import { useSignedOut } from "./hooks";

export type ConversationMessage = UIMessage<MessageMetadata>;

export interface Conversation {
  messages: ConversationMessage[];
  /** The Workspace agent's state, or null until the socket first sends it. */
  state: ConversationState | null;
  /** Whether the socket is open and the platform has sent the state. */
  connected: boolean;
  /** Whether the socket closed and won't reconnect. */
  failed: boolean;
  /** Whether the Developer's sign-in expired, which stops the socket until they sign in again. */
  signedOut: boolean;
  /** Whether a Turn's reply is arriving. */
  streaming: boolean;
  /** Whether connected with no Turn running and no Start fresh under way, so the Developer may start either. */
  idle: boolean;
}

/**
 * A Workspace's Conversation, on the Agents SDK's own WebSocket protocol. The
 * socket only watches: the history and each Turn's reply arrive on it, but
 * Turns start over HTTP (`startTurn`), and the platform drops anything the
 * socket sends but the stream-resume handshake, so `useAgentChat`'s
 * `sendMessage` and `clearHistory` do nothing.
 */
export function useConversation(id: string): Conversation {
  const signedOut = useSignedOut();
  const agent = useAgent<ConversationState>({
    // The platform routes the socket itself, so `basePath` makes `agent` only a label.
    agent: "workspace",
    basePath: conversationBasePath(id),
    enabled: !signedOut,
    // Access refuses an expired sign-in's socket as it would any request, but the
    // browser shows the socket only a dropped connection, so ask over HTTP.
    onClose: () => void checkSignIn(),
  });
  const transcript = useAgentChat<ConversationState, ConversationMessage>({
    agent,
    // The history arrives on the socket, so don't fetch it over HTTP too.
    getInitialMessages: null,
  });

  const state = agent.state ?? null;
  return {
    messages: transcript.messages,
    state,
    connected: agent.identified,
    failed: agent.connectionError !== null,
    signedOut,
    streaming: transcript.isStreaming,
    idle: agent.identified && state !== null && state.turn === null && !state.startingFresh,
  };
}
