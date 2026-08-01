import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLASSIFICATION = "R2_DIAGNOSTIC_REPLAY";
const REDACTED_PROMPT = "[REDACTED_PROMPT]";
const REDACTED_SENSITIVE = "[REDACTED_SENSITIVE]";
const REDACTED_HTML = "[REDACTED_HTML]";

const SENSITIVE_KEY = /(?:^|[_-])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|set[_-]?cookie|oauth|credential|credentials|secret|screenshot|page[_-]?html|assistant[_-]?output)(?:$|[_-])/i;
const HTML_DOCUMENT = /(?:<!doctype\s+html|<html[\s>]|<body[\s>])/i;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT = /\b(access_token|refresh_token|id_token|oauth_token|authorization|cookie)\b\s*[:=]\s*([^\s,;]+)/gi;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactString(value, prompt) {
  let redacted = value;
  if (prompt.length > 0) redacted = redacted.split(prompt).join(REDACTED_PROMPT);
  redacted = redacted.replace(DATA_IMAGE, REDACTED_SENSITIVE);
  redacted = redacted.replace(BEARER_TOKEN, "Bearer [REDACTED]");
  redacted = redacted.replace(JWT_TOKEN, REDACTED_SENSITIVE);
  redacted = redacted.replace(SECRET_ASSIGNMENT, (_match, key) => `${key}=${REDACTED_SENSITIVE}`);
  if (HTML_DOCUMENT.test(redacted)) return REDACTED_HTML;
  return redacted;
}

export function redactForReceipt(value, prompt, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value, prompt);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return "[UNSERIALIZABLE]";

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactForReceipt(entry, prompt, seen));
    }

    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY.test(key)
        ? REDACTED_SENSITIVE
        : redactForReceipt(entry, prompt, seen);
    }
    return redacted;
  } finally {
    seen.delete(value);
  }
}

function serializeError(error, prompt) {
  if (error instanceof Error) {
    return redactForReceipt(
      {
        name: error.name,
        message: error.message,
        stack: error.stack ?? null,
        cause: error.cause ?? null,
      },
      prompt,
    );
  }
  return redactForReceipt({ name: "NonErrorThrown", message: String(error) }, prompt);
}

function validateToolsList(listed) {
  if (!isPlainObject(listed) || !Array.isArray(listed.tools)) {
    return "MALFORMED_TOOLS_LIST";
  }
  if (
    listed.tools.some(
      (tool) => !isPlainObject(tool) || typeof tool.name !== "string" || tool.name.length === 0,
    )
  ) {
    return "MALFORMED_TOOL_ENTRY";
  }
  return null;
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
    acknowledgement.slice === "WEB-LAUNCH-0" &&
    acknowledgement.launchSuccess === true &&
    typeof acknowledgement.conversationIdentitySha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(acknowledgement.conversationIdentitySha256) &&
    typeof acknowledgement.timestamp === "string" &&
    !Number.isNaN(Date.parse(acknowledgement.timestamp)) &&
    acknowledgement.assistantOutputCaptured === false
  );
}

function receiptHash(receiptWithoutHash) {
  return sha256(Buffer.from(JSON.stringify(receiptWithoutHash), "utf8"));
}

export function verifyReceiptHash(receipt) {
  if (!isPlainObject(receipt) || typeof receipt.receiptSha256 !== "string") return false;
  const { receiptSha256, ...withoutHash } = receipt;
  return receiptSha256 === receiptHash(withoutHash);
}

export async function writeReceiptAtomic(outputPath, receipt) {
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

export async function recordWebLaunchOutcome({
  client,
  connect = async () => undefined,
  outputPath,
  prompt,
  deployedSha,
  classification = CLASSIFICATION,
  expectedToolCount = 10,
  expectedWebLaunchCount = 1,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
}) {
  if (!client || typeof client.listTools !== "function" || typeof client.callTool !== "function") {
    throw new TypeError("A compatible MCP client is required.");
  }
  if (typeof client.close !== "function") throw new TypeError("The MCP client must support close().");
  if (typeof prompt !== "string" || prompt.length === 0) throw new TypeError("A non-empty prompt is required.");
  if (typeof deployedSha !== "string" || !/^[a-f0-9]{40}$/i.test(deployedSha)) {
    throw new TypeError("deployedSha must be a full 40-character Git SHA.");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath is required.");
  }

  const started = monotonicNow();
  const startedAt = now().toISOString();
  let toolCount = null;
  let webLaunchCount = null;
  let callReturned = false;
  let returnedResult = null;
  let transportError = null;
  let clientCloseError = null;
  let recorderError = null;

  try {
    await connect();
    const listed = await client.listTools();
    recorderError = validateToolsList(listed);
    if (!recorderError) {
      toolCount = listed.tools.length;
      webLaunchCount = listed.tools.filter((tool) => tool.name === "web_launch").length;
      if (toolCount !== expectedToolCount || webLaunchCount !== expectedWebLaunchCount) {
        recorderError = `TOOL_INVENTORY_MISMATCH expected=${expectedToolCount}/${expectedWebLaunchCount} actual=${toolCount}/${webLaunchCount}`;
      }
    }

    if (!recorderError) {
      try {
        returnedResult = await client.callTool({
          name: "web_launch",
          arguments: { prompt },
        });
        callReturned = true;
        recorderError = validateReturnedResult(returnedResult);
        if (!recorderError && returnedResult.isError !== true && !isSuccessfulAcknowledgement(returnedResult)) {
          recorderError = "MALFORMED_SUCCESS_ACKNOWLEDGEMENT";
        }
      } catch (error) {
        transportError = serializeError(error, prompt);
      }
    }
  } catch (error) {
    transportError = serializeError(error, prompt);
  } finally {
    try {
      await client.close();
    } catch (error) {
      clientCloseError = serializeError(error, prompt);
    }
  }

  const isError = callReturned ? returnedResult.isError === true : null;
  const content = callReturned ? redactForReceipt(returnedResult.content, prompt) : [];
  const structuredContent =
    callReturned && returnedResult.structuredContent !== undefined
      ? redactForReceipt(returnedResult.structuredContent, prompt)
      : null;
  const rawMeta = callReturned ? (returnedResult.meta ?? returnedResult._meta) : undefined;
  const meta = rawMeta === undefined ? null : redactForReceipt(rawMeta, prompt);
  const elapsedMs = Math.max(0, Math.round(monotonicNow() - started));

  const receiptWithoutHash = {
    classification,
    deployedSha,
    toolCount,
    webLaunchCount,
    startedAt,
    elapsedMs,
    promptSha256: sha256(Buffer.from(prompt, "utf8")),
    promptLength: prompt.length,
    callReturned,
    isError,
    content,
    structuredContent,
    meta,
    transportError,
    clientCloseError,
    recorderError,
  };
  const receipt = {
    ...receiptWithoutHash,
    receiptSha256: receiptHash(receiptWithoutHash),
  };

  const finalOutputPath = await writeReceiptAtomic(outputPath, receipt);
  const success =
    callReturned &&
    isError === false &&
    transportError === null &&
    clientCloseError === null &&
    recorderError === null &&
    isSuccessfulAcknowledgement(returnedResult);
  const exitCode = success ? 0 : transportError || clientCloseError ? 3 : recorderError ? 4 : 2;

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
      client_name: "web-launch-live-recorder",
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
  const prompt = process.env.WEB_LAUNCH_PROMPT;
  let accessToken = process.env.DEVSPACE_ACCESS_TOKEN;

  if (!endpoint || !outputPath || !deployedSha) {
    throw new Error("Required arguments: --url, --output, --deployed-sha");
  }
  if (!prompt) throw new Error("WEB_LAUNCH_PROMPT must contain the invocation prompt.");

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

  const requestInit = accessToken
    ? { headers: { Authorization: `Bearer ${accessToken}` } }
    : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit });
  const client = new Client({ name: "web-launch-live-recorder", version: "1.0.0" });
  const outcome = await recordWebLaunchOutcome({
    client,
    connect: async () => client.connect(transport),
    outputPath,
    prompt,
    deployedSha,
    classification,
  });

  process.stderr.write(
    `web-launch recorder classification=${classification} exit=${outcome.exitCode} receipt=${outcome.outputPath}\n`,
  );
  process.exitCode = outcome.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const safe = serializeError(error, process.env.WEB_LAUNCH_PROMPT ?? "");
    process.stderr.write(`web-launch recorder failed: ${JSON.stringify(safe)}\n`);
    process.exitCode = 4;
  });
}
