import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { WebChatController } from "./web-chat.js";

const NO_APP_META = { _meta: {} } as const;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MESSAGE_CHARS = 20_000;

const boundedMessage = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_CHARS)
  .refine((value) => !value.includes("\r"), "Carriage returns are not allowed.");

const replyWireSchema = z
  .object({
    challenge: z.string().regex(HEX_64_PATTERN),
    turn: z.number().int().positive(),
    message: boundedMessage,
  })
  .passthrough();

export function registerWebChatTools(input: {
  server: McpServer;
  chat: Pick<
    WebChatController,
    "startChat" | "sendChat" | "getChatStatus" | "closeChat" | "acceptReply"
  >;
}): void {
  const { server, chat } = input;

  registerAppTool(
    server,
    "web_chat_start",
    {
      title: "Start retained Web chat",
      description:
        "WEB-CHAT-3 only. After an explicit user request, starts one bounded asynchronous chat in exactly one fresh retained ChatGPT Web conversation. Returns a server-generated chatId immediately. The spawned conversation returns its reply through web_chat_reply; DevSpace does not scrape assistant output.",
      inputSchema: {
        message: boundedMessage.describe("Exact first message for the spawned conversation."),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ message }) => {
      const acknowledgement = chat.startChat(message);
      return {
        content: [
          {
            type: "text" as const,
            text: "WEB-CHAT-3 chat started. Use web_chat_status with the returned chatId.",
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );

  registerAppTool(
    server,
    "web_chat_send",
    {
      title: "Send retained Web chat turn",
      description:
        "WEB-CHAT-3 only. Sends one next message into the same retained spawned ChatGPT Web conversation. Requires the preceding turn to be complete and permits only one in-flight turn.",
      inputSchema: {
        chatId: z.string().regex(HEX_64_PATTERN),
        message: boundedMessage.describe("Exact next message for the retained conversation."),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ chatId, message }) => {
      const acknowledgement = chat.sendChat(chatId, message);
      return {
        content: [
          {
            type: "text" as const,
            text: "WEB-CHAT-3 turn sent. Use web_chat_status for the returned reply.",
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );

  registerAppTool(
    server,
    "web_chat_status",
    {
      title: "Read retained Web chat status",
      description:
        "WEB-CHAT-3 only. Reads bounded in-memory chat state and the latest explicitly submitted reply. It does not inspect browser content or expose raw ChatGPT identities.",
      inputSchema: {
        chatId: z.string().regex(HEX_64_PATTERN),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ chatId }) => {
      const acknowledgement = chat.getChatStatus(chatId);
      return {
        content: [
          {
            type: "text" as const,
            text: `WEB-CHAT-3 status: ${acknowledgement.status}.`,
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );

  registerAppTool(
    server,
    "web_chat_close",
    {
      title: "Close retained Web chat",
      description:
        "WEB-CHAT-3 only. Explicitly closes the retained spawned conversation page and invalidates any outstanding callback challenge.",
      inputSchema: {
        chatId: z.string().regex(HEX_64_PATTERN),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ chatId }) => {
      const acknowledgement = await chat.closeChat(chatId);
      return {
        content: [{ type: "text" as const, text: "WEB-CHAT-3 chat closed." }],
        structuredContent: acknowledgement,
      };
    },
  );

  registerAppTool(
    server,
    "web_chat_reply",
    {
      title: "Return retained Web chat reply",
      description:
        "WEB-CHAT-3 internal bounded callback. Invoke exactly once only when the current spawned conversation contains a WEB-CHAT-3 challenge and turn number. Harmless unknown fields are ignored. The server owns chatId, ordering, timestamps, expiry, and conversation identity.",
      inputSchema: replyWireSchema,
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const acknowledgement = chat.acceptReply({
        challenge: args.challenge,
        turn: args.turn,
        message: args.message,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: "WEB-CHAT-3 reply accepted. Stop without invoking another tool.",
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );
}
