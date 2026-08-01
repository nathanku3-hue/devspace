import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLASSIFICATION = "WEB_CONNECTOR_1_LIVE_ACCEPTANCE";
const DEFAULT_REQUEST_TIMEOUT_MS = 165_000;
const MINIMUM_REQUEST_TIMEOUT_MS = 150_000;
const CLIENT_REQUEST_TIMEOUT_CODE = -32001;
const SERVER_PROBE_TIMEOUT = /WEB-CONNECTOR-1 timed out waiting for the spawned conversation to invoke DevSpace/i;
const REDACTED_SENSITIVE = "[REDACTED_SENSITIVE]";
const REDACTED_HTML = "[REDACTED_HTML]";

const SENSITIVE_KEY = /(?:^|[_-])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|set[_-]?cookie|oauth|credential|credentials|secret|screenshot|page[_-]?html|assistant[_-]?output)(?:$|[_-])/i;
const HTML_DOCUMENT = /(?:<!doctype\s+html|<html[\s>]|<body[\s>])/i;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT = /\b(access_token|refresh_token|id_token|oauth_token|authorization|cookie)\b\s*[:=]\s*([^\s,;]+)/gi;

export const EXPECTED_TOOL_NAMES = Object.freeze([
  "bash",
  "close_workspace",
  "edit",
  "open_workspace",
  "publish_git_changes",
  "read",
  "read_files",
  "safe_rename_file",
  "web_connector_probe",
  "web_connector_proof",
  "web_launch",
  "write",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactString(value) {
  let redacted = value;
  redacted = redacted.replace(DATA_IMAGE, REDACTED_SENSITIVE);
  redacted = redacted.replace(BEARER_TOKEN, "Bearer [REDACTED]");
  redacted = redacted.replace(JWT_TOKEN, REDACTED_SENSITIVE);
  redacted = redacted.replace(SECRET_ASSIGNMENT, (_match, key) => `${key}=${REDACTED_SENSITIVE}`);
  if (HTML_DOCUMENT.test(redacted)) return REDACTED_HTML;
  return redacted;
}

export function redactForConnectorReceipt(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return "[UNSERIALIZABLE]";

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactForConnectorReceipt(entry, seen));
    }

    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY.test(key)
        ? REDACTED_SENSITIVE
        : redactForConnectorReceipt(entry, seen);
    }
    return redacted;
  } finally {
    seen.delete(value);
  }
}

function serializeProtocolError(error) {
  if (error instanceof Error || isPlainObject(error)) {
    return redactForConnectorReceipt({
      name: typeof error.name === "string" ? error.name : "Error",
      message: typeof error.message === "string" ? error.message : String(error),
      code: typeof error.code === "number" || typeof error.code === "string" ? error.code : null,
      data: error.data ?? null,
      cause: error.cause ?? null,
    });
  }
  return redactForConnectorReceipt({
    name: "NonErrorThrown",
    message: String(error),
    code: null,
    data: null,
    cause: null,
  });
}

function validateToolsList(listed, expectedToolNames) {
  if (!isPlainObject(listed) || !Array.isArray(listed.tools)) {
    return {
      error: "MALFORMED_TOOLS_LIST",
      inventory: [],
      proofCount: null,
      probeCount: null,
    };
  }

  const inventory = listed.tools.map((tool) =>
    isPlainObject(tool) && typeof tool.name === "string" && tool.name.length > 0
      ? tool.name
      : "[MALFORMED_TOOL_ENTRY]",
  );
  if (inventory.includes("[MALFORMED_TOOL_ENTRY]")) {
    return {
      error: "MALFORMED_TOOL_ENTRY",
      inventory,
      proofCount: inventory.filter((name) => name === "web_connector_proof").length,
      probeCount: inventory.filter((name) => name === "web_connector_probe").length,
    };
  }

  const proofCount = inventory.filter((name) => name === "web_connector_proof").length;
  const probeCount = inventory.filter((name) => name === "web_connector_probe").length;
  const expected = [...expectedToolNames].sort();
  const actual = [...inventory].sort();
  const exactInventory =
    actual.length === expected.length && actual.every((name, index) => name === expected[index]);

  return {
    error:
      exactInventory && proofCount === 1 && probeCount === 1
        ? null
        : `TOOL_INVENTORY_MISMATCH expected=${expected.join(",")} actual=${actual.join(",")} proof=${proofCount} probe=${probeCount}`,
    inventory,
    proofCount,
    probeCount,
  };
}

function validateReturnedResult(result) {
  if (!isPlainObject(result)) return "MALFORMED_TOOL_RESULT";
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    return "MALFORMED_IS_ERROR";
  }
  if (!Array.isArray(result.content)) return "MALFORMED_CONTENT";
  if (
    result.content.some(
      (block) => !isPlainObject(block) || typeof block.type !== "string" || block.type.length === 0,
    )
  ) {
    return "MALFORMED_CONTENT_BLOCK";
  }
  return null;
}

function isSuccessfulAcknowledgement(result) {
  if (result?.isError === true || !isPlainObject(result?.structuredContent)) return false;
  const acknowledgement = result.structuredContent;
  return (
    acknowledgement.slice === "WEB-CONNECTOR-1" &&
    acknowledgement.connectorDiscovered === true &&
    acknowledgement.connectorInvoked === true &&
    acknowledgement.probeTool === "web_connector_probe" &&
    typeof acknowledgement.conversationIdentitySha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(acknowledgement.conversationIdentitySha256) &&
    typeof acknowledgement.invocationTimestamp === "string" &&
    !Number.isNaN(Date.parse(acknowledgement.invocationTimestamp)) &&
    acknowledgement.assistantOutputCaptured === false
  );
}

function ordinaryText(result) {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((block) => isPlainObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function classifyReturnedFailure(result) {
  if (result?.isError !== true) return null;
  return SERVER_PROBE_TIMEOUT.test(ordinaryText(result)) ? "SERVER_PROBE_TIMEOUT" : "TOOL_ERROR";
}

function classifyProtocolError(error) {
  const code = error?.code;
  const message = typeof error?.message === "string" ? error.message : String(error);
  return code === CLIENT_REQUEST_TIMEOUT_CODE || /request timed out/i.test(message)
    ? "CLIENT_REQUEST_TIMEOUT"
    : "TRANSPORT_OR_PROTOCOL_ERROR";
}

function receiptHash(receiptWithoutHash) {
  return sha256(Buffer.from(JSON.stringify(receiptWithoutHash), "utf8"));
}

export function verifyConnectorReceiptHash(receipt) {
  if (!isPlainObject(receipt) || typeof receipt.receiptSha256 !== "string") return false;
  const { receiptSha256, ...withoutHash } = receipt;
  return receiptSha256 === receiptHash(withoutHash);
}

export async function writeConnectorReceiptAtomic(outputPath, receipt) {
  const absoluteOutput = resolve(outputPath);
  const outputDirectory = dirname(absoluteOutput);
  await mkdir(outputDirectory, { recursive: true });

  try {
    await access(absoluteOutput);
    throw new Error("RECEIPT_ALREADY_EXISTS");
  } catch (error) {
    if (error?.message === "RECEIPT_ALREADY_EXISTS") throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = resolve(
    outputDirectory,
    `.${basename(absoluteOutput)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, absoluteOutput);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return absoluteOutput;
}

export async function recordWebConnectorOutcome({
  client,
  connect = async () => undefined,
  outputPath,
  deployedSha,
  classification = CLASSIFICATION,
  expectedToolNames = EXPECTED_TOOL_NAMES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
}) {
  if (!client || typeof client.listTools !== "function" || typeof client.callTool !== "function") {
    throw new TypeError("A compatible MCP client is required.");
  }
  if (typeof client.close !== "function") throw new TypeError("The MCP client must support close().");
  if (typeof deployedSha !== "string" || !/^[a-f0-9]{40}$/i.test(deployedSha)) {
    throw new TypeError("deployedSha must be a full 40-character Git SHA.");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath is required.");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < MINIMUM_REQUEST_TIMEOUT_MS) {
    throw new TypeError(`requestTimeoutMs must be an integer of at least ${MINIMUM_REQUEST_TIMEOUT_MS}.`);
  }
  if (!Array.isArray(expectedToolNames) || expectedToolNames.length === 0) {
    throw new TypeError("expectedToolNames must be a non-empty array.");
  }

  const started = monotonicNow();
  const startedAt = now().toISOString();
  let authenticatedToolInventory = [];
  let toolCount = null;
  let webConnectorProofCount = null;
  let webConnectorProbeCount = null;
  let callReturned = false;
  let callDurationMs = null;
  let returnedResult = null;
  let transportProtocolError = null;
  let clientCloseError = null;
  let recorderError = null;
  let failureKind = null;

  try {
    await connect();
    const listed = await client.listTools();
    const inventory = validateToolsList(listed, expectedToolNames);
    authenticatedToolInventory = inventory.inventory;
    toolCount = inventory.inventory.length;
    webConnectorProofCount = inventory.proofCount;
    webConnectorProbeCount = inventory.probeCount;
    recorderError = inventory.error;

    if (!recorderError) {
      const callStarted = monotonicNow();
      try {
        returnedResult = await client.callTool(
          { name: "web_connector_proof", arguments: {} },
          undefined,
          { timeout: requestTimeoutMs },
        );
        callReturned = true;
        callDurationMs = Math.max(0, Math.round(monotonicNow() - callStarted));
        recorderError = validateReturnedResult(returnedResult);
        if (!recorderError) {
          failureKind = classifyReturnedFailure(returnedResult);
          if (returnedResult.isError !== true && !isSuccessfulAcknowledgement(returnedResult)) {
            recorderError = "MALFORMED_SUCCESS_ACKNOWLEDGEMENT";
            failureKind = "RECORDER_VALIDATION_FAILURE";
          }
        }
      } catch (error) {
        callDurationMs = Math.max(0, Math.round(monotonicNow() - callStarted));
        transportProtocolError = serializeProtocolError(error);
        failureKind = classifyProtocolError(error);
      }
    } else {
      failureKind = "INVENTORY_FAILURE";
    }
  } catch (error) {
    transportProtocolError = serializeProtocolError(error);
    failureKind = classifyProtocolError(error);
  } finally {
    try {
      await client.close();
    } catch (error) {
      clientCloseError = serializeProtocolError(error);
      failureKind ??= "TRANSPORT_OR_PROTOCOL_ERROR";
    }
  }

  const isError = callReturned ? returnedResult.isError === true : null;
  const content = callReturned ? redactForConnectorReceipt(returnedResult.content) : [];
  const structuredContent =
    callReturned && returnedResult.structuredContent !== undefined
      ? redactForConnectorReceipt(returnedResult.structuredContent)
      : null;
  const elapsedMs = Math.max(0, Math.round(monotonicNow() - started));

  const receiptWithoutHash = {
    classification,
    deployedSha,
    authenticatedToolInventory,
    toolCount,
    webConnectorProofCount,
    webConnectorProbeCount,
    requestTimeoutMs,
    startedAt,
    elapsedMs,
    callDurationMs,
    callReturned,
    isError,
    content,
    structuredContent,
    failureKind,
    transportProtocolError,
    clientCloseError,
    recorderError,
  };
  const receipt = {
    ...receiptWithoutHash,
    receiptSha256: receiptHash(receiptWithoutHash),
  };

  const finalOutputPath = await writeConnectorReceiptAtomic(outputPath, receipt);
  const success =
    callReturned &&
    isError === false &&
    transportProtocolError === null &&
    clientCloseError === null &&
    recorderError === null &&
    failureKind === null &&
    isSuccessfulAcknowledgement(returnedResult);
  const exitCode = success
    ? 0
    : transportProtocolError || clientCloseError
      ? 3
      : recorderError
        ? 4
        : 2;

  return { exitCode, outputPath: finalOutputPath, receipt };
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function readOwnerToken() {
  if (process.env.DEVSPACE_OWNER_TOKEN) return process.env.DEVSPACE_OWNER_TOKEN;
  const authPath =
    process.env.DEVSPACE_AUTH_FILE ?? join(process.env.USERPROFILE ?? homedir(), ".devspace", "auth.json");
  const parsed = JSON.parse(await readFile(authPath, "utf8"));
  if (typeof parsed.ownerToken !== "string" || parsed.ownerToken.length === 0) {
    throw new Error("DEVSPACE_OWNER_TOKEN_MISSING");
  }
  return parsed.ownerToken;
}

async function issueAccessToken({ baseUrl, resourceUrl, ownerToken }) {
  const redirectUri = "http://127.0.0.1:9/callback";
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(16).toString("hex");

  const registrationResponse = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "web-connector-live-recorder",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!registrationResponse.ok) {
    throw new Error(`OAUTH_CLIENT_REGISTRATION_FAILED status=${registrationResponse.status}`);
  }
  const clientInfo = await registrationResponse.json();
  if (typeof clientInfo.client_id !== "string" || clientInfo.client_id.length === 0) {
    throw new Error("OAUTH_CLIENT_REGISTRATION_MALFORMED");
  }

  const authorizationResponse = await fetch(new URL("/authorize", baseUrl), {
    method: "POST",
    body: new URLSearchParams({
      response_type: "code",
      client_id: clientInfo.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource: resourceUrl,
      owner_token: ownerToken,
      state,
    }),
    redirect: "manual",
  });
  if (![302, 303].includes(authorizationResponse.status)) {
    throw new Error(`OAUTH_AUTHORIZATION_FAILED status=${authorizationResponse.status}`);
  }
  const location = authorizationResponse.headers.get("location");
  if (!location) throw new Error("OAUTH_AUTHORIZATION_REDIRECT_MISSING");
  const redirect = new URL(location);
  if (redirect.searchParams.get("state") !== state) {
    throw new Error("OAUTH_AUTHORIZATION_STATE_MISMATCH");
  }
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("OAUTH_AUTHORIZATION_CODE_MISSING");

  const tokenResponse = await fetch(new URL("/token", baseUrl), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientInfo.client_id,
      code_verifier: verifier,
      resource: resourceUrl,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`OAUTH_TOKEN_EXCHANGE_FAILED status=${tokenResponse.status}`);
  }
  const tokens = await tokenResponse.json();
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new Error("OAUTH_TOKEN_EXCHANGE_MALFORMED");
  }
  return tokens.access_token;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const endpoint = argumentsMap.get("url");
  const outputPath = argumentsMap.get("output");
  const deployedSha = argumentsMap.get("deployed-sha");
  const classification = argumentsMap.get("classification") ?? CLASSIFICATION;
  const requestTimeoutMs = Number(
    argumentsMap.get("request-timeout-ms") ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  if (!endpoint || !outputPath || !deployedSha) {
    throw new Error("Required arguments: --url, --output, --deployed-sha");
  }

  const client = new Client({ name: "web-connector-live-recorder", version: "1.0.0" });
  const outcome = await recordWebConnectorOutcome({
    client,
    connect: async () => {
      let accessToken = process.env.DEVSPACE_ACCESS_TOKEN;
      if (!accessToken) {
        const endpointUrl = new URL(endpoint);
        const baseUrl = new URL(endpointUrl.origin);
        const resourceUrl = argumentsMap.get("resource") ?? endpoint;
        accessToken = await issueAccessToken({
          baseUrl,
          resourceUrl,
          ownerToken: await readOwnerToken(),
        });
      }

      const requestInit = { headers: { Authorization: `Bearer ${accessToken}` } };
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit });
      await client.connect(transport);
    },
    outputPath,
    deployedSha,
    classification,
    requestTimeoutMs,
  });

  process.stderr.write(
    `web-connector recorder classification=${classification} exit=${outcome.exitCode} receipt=${outcome.outputPath}\n`,
  );
  process.exitCode = outcome.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const safe = serializeProtocolError(error);
    process.stderr.write(`web-connector recorder failed: ${JSON.stringify(safe)}\n`);
    process.exitCode = 4;
  });
}
