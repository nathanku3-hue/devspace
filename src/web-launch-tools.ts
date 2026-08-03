import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";

const NO_APP_META = { _meta: {} } as const;

export function registerWebLaunchTool(input: {
  server: McpServer;
  browser: Pick<WebLaunchBrowserController, "launchWebConversation">;
}): void {
  const { server, browser } = input;

  registerAppTool(
    server,
    "web_launch",
    {
      title: "Launch ChatGPT conversation",
      description:
        "WEB-LAUNCH-0 only. Use after the user explicitly requests this action from the current ChatGPT Web conversation. Launch the dedicated external headed Chrome profile, create exactly one fresh chatgpt.com conversation, submit the supplied prompt unchanged, and return only a hashed launch acknowledgement. This tool does not read assistant output, bind reviewers, test connector visibility, or continue the spawned conversation.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(100_000)
          .describe(
            "Exact prompt to insert and submit. Carriage returns are rejected rather than modified.",
          ),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt }) => {
      const acknowledgement = await browser.launchWebConversation(prompt);
      return {
        content: [{ type: "text" as const, text: "WEB-LAUNCH-0 launch succeeded." }],
        structuredContent: acknowledgement,
      };
    },
  );
}
