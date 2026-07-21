import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { DeviceAuthorization, type DeviceAuthorizationConfig } from "./device-authorization.js";
import {
  SqliteOAuthClientsStore,
  SqliteOAuthStore,
  type RedirectUriAlias,
} from "./oauth-store.js";

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
  redirectUriAliases?: RedirectUriAlias[];
  deviceAuthorization: DeviceAuthorizationConfig;
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
  deviceBound: boolean;
}

const CODE_TTL_MS = 5 * 60 * 1000;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
  deviceAuthorization: boolean;
}): string {
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "devspace";
  const resourceText = params.resource?.href ?? "DevSpace MCP endpoint";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");
  const approvalControls = params.deviceAuthorization
    ? `        <p id="devspace-device-status" class="status">Checking this enrolled PC…</p>\n        <button id="devspace-device-retry" type="button">Retry device check</button>`
    : `        <label for="owner_token">Owner password</label>\n        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />\n        <button type="submit">Authorize DevSpace</button>`;
  const formAttributes = params.deviceAuthorization
    ? ` data-devspace-device-auth="required"`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect DevSpace</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 440px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
      .status { color: #bae6fd; background: #082f49; border-radius: 10px; padding: 10px 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect DevSpace</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post"${formAttributes}>
${hiddenFields}
${approvalControls}
      </form>
    </main>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly oauthStore: SqliteOAuthStore;
  private readonly resourceServerUrl: URL;
  private readonly deviceAuthorization?: DeviceAuthorization;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.oauthStore = new SqliteOAuthStore(stateDir);
    if (config.deviceAuthorization.enabled) {
      this.deviceAuthorization = new DeviceAuthorization(config.deviceAuthorization);
      this.deviceAuthorization.start();
    }
    this.clientsStore = new SqliteOAuthClientsStore(
      this.oauthStore,
      config.allowedRedirectHosts,
      config.redirectUriAliases ?? [],
    );
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const resource = params.resource ?? this.resourceServerUrl;
    if (!checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    const normalizedParams: AuthorizationParams = { ...params, resource };
    const redirectUsesDeviceAuthorization = Boolean(
      this.deviceAuthorization?.isRedirectAllowed(normalizedParams.redirectUri),
    );
    if (
      this.config.deviceAuthorization.enabled &&
      this.config.deviceAuthorization.required &&
      !redirectUsesDeviceAuthorization
    ) {
      throw new AccessDeniedError("This DevSpace server only authorizes the enrolled Chatshare device");
    }

    const binding = redirectUsesDeviceAuthorization
      ? authorizationBinding(client, normalizedParams)
      : undefined;

    if (res.req.method !== "POST") {
      const challenge = binding ? this.deviceAuthorization?.createChallenge(binding) : undefined;
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: normalizedParams.scopes ?? this.config.scopes,
          resource,
          fields: authorizationFormFields(client, normalizedParams, challenge, binding),
          deviceAuthorization: Boolean(challenge),
        }),
      );
      return;
    }

    let deviceBound = false;
    if (binding && this.deviceAuthorization) {
      const challenge = String(res.req.body?.device_challenge ?? "");
      const submittedBinding = String(res.req.body?.device_binding ?? "");
      const proof = String(res.req.body?.device_proof ?? "");
      if (
        submittedBinding !== binding ||
        !this.deviceAuthorization.verifyProof(challenge, binding, proof)
      ) {
        const replacementChallenge = this.deviceAuthorization.createChallenge(binding);
        res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.send(
          formHtml({
            error: "This authorization was not signed by the enrolled PC.",
            clientName: client.client_name ?? client.client_id,
            scopes: normalizedParams.scopes ?? this.config.scopes,
            resource,
            fields: authorizationFormFields(
              client,
              normalizedParams,
              replacementChallenge,
              binding,
            ),
            deviceAuthorization: true,
          }),
        );
        return;
      }
      deviceBound = true;
    } else {
      const providedToken = String(res.req.body?.owner_token ?? "");
      if (!safeEquals(providedToken, this.config.ownerToken)) {
        res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.send(
          formHtml({
            error: "The Owner password was not accepted.",
            clientName: client.client_name ?? client.client_id,
            scopes: normalizedParams.scopes ?? this.config.scopes,
            resource,
            fields: authorizationFormFields(client, normalizedParams),
            deviceAuthorization: false,
          }),
        );
        return;
      }
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params: normalizedParams,
      expiresAtMs: Date.now() + CODE_TTL_MS,
      deviceBound,
    });

    const redirectUrl = new URL(normalizedParams.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (normalizedParams.state !== undefined) redirectUrl.searchParams.set("state", normalizedParams.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(
      client.client_id,
      record.params.scopes ?? this.config.scopes,
      record.params.resource,
      record.deviceBound,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.oauthStore.getRefreshToken(refreshTokenHash);
    if (
      !record ||
      record.clientId !== client.client_id ||
      record.expiresAt < Math.floor(Date.now() / 1000) ||
      (this.config.deviceAuthorization.required && !record.deviceBound)
    ) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    return this.issueTokens(
      client.client_id,
      requestedScopes,
      resource ?? (record.resource ? new URL(record.resource) : undefined),
      Boolean(record.deviceBound),
      refreshTokenHash,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (
      !record ||
      record.expiresAt < Math.floor(Date.now() / 1000) ||
      (this.config.deviceAuthorization.required && !record.deviceBound)
    ) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.oauthStore.deleteAccessToken(hashed);
    this.oauthStore.deleteRefreshToken(hashed);
  }

  close(): void {
    this.deviceAuthorization?.close();
    this.oauthStore.close();
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    deviceBound: boolean,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          clientId,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resource?.href,
          deviceBound,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
          scopes,
          expiresAt: refreshExpiresAt,
          resource: resource?.href,
          deviceBound,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  deviceChallenge?: string,
  deviceBinding?: string,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
    device_challenge: deviceChallenge,
    device_binding: deviceBinding,
    device_proof: deviceChallenge ? "" : undefined,
  };
}

function authorizationBinding(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): string {
  const canonical = JSON.stringify({
    clientId: client.client_id,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    scopes: params.scopes ?? [],
    state: params.state ?? null,
    resource: params.resource?.href ?? null,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
