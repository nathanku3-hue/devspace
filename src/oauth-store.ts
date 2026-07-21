import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
  deviceBound?: boolean;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
  deviceBound?: boolean;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

export interface RedirectUriAlias {
  registeredBase: string;
  requestedBase: string;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return true;

  return allowedHosts.some((entry) => {
    const allowedHost = entry.trim().toLowerCase();
    if (!allowedHost.startsWith("*.")) return hostname === allowedHost;

    const suffix = allowedHost.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  });
}

function redirectUriIdentity(redirectUri: string): string {
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.host.toLowerCase();
    }
    return parsed.protocol.toLowerCase();
  } catch {
    return "invalid-uri";
  }
}

function applyRedirectUriAlias(redirectUri: string, alias: RedirectUriAlias): string | undefined {
  let registered: URL;
  let requested: URL;
  let original: URL;
  try {
    registered = new URL(alias.registeredBase);
    requested = new URL(alias.requestedBase);
    original = new URL(redirectUri);
  } catch {
    return undefined;
  }

  if (
    original.protocol !== registered.protocol ||
    original.host.toLowerCase() !== registered.host.toLowerCase() ||
    !original.pathname.startsWith(registered.pathname)
  ) {
    return undefined;
  }

  const pathSuffix = original.pathname.slice(registered.pathname.length);
  const aliased = new URL(requested.href);
  aliased.pathname = `${requested.pathname}${pathSuffix}`;
  aliased.search = original.search;
  aliased.hash = original.hash;
  return aliased.href;
}

function clientWithRedirectUriAliases(
  client: OAuthClientInformationFull,
  aliases: RedirectUriAlias[],
  allowedRedirectHosts: string[],
): OAuthClientInformationFull {
  if (aliases.length === 0) return client;

  const redirectUris = new Set(client.redirect_uris.map(String));
  for (const redirectUri of client.redirect_uris.map(String)) {
    for (const alias of aliases) {
      const aliased = applyRedirectUriAlias(redirectUri, alias);
      if (aliased && redirectHostAllowed(aliased, allowedRedirectHosts)) {
        redirectUris.add(aliased);
      }
    }
  }

  if (redirectUris.size === client.redirect_uris.length) return client;
  return { ...client, redirect_uris: Array.from(redirectUris) };
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    const rejectedRedirectUris = client.redirect_uris
      .map(String)
      .filter((uri) => !redirectHostAllowed(uri, allowedRedirectHosts));
    if (rejectedRedirectUris.length > 0) {
      const rejectedIdentities = Array.from(new Set(rejectedRedirectUris.map(redirectUriIdentity)));
      throw new InvalidRequestError(
        `Client redirect_uri is not allowed for this DevSpace server: ${rejectedIdentities.join(", ")}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource, device_bound)
         values (?, ?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource,
           device_bound = excluded.device_bound`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
        record.deviceBound ? 1 : 0,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource, device_bound from oauth_access_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
          device_bound: number;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource, device_bound)
         values (?, ?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource,
           device_bound = excluded.device_bound`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
        record.deviceBound ? 1 : 0,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) return false;
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource, device_bound from oauth_refresh_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
          device_bound: number;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at < ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at < ?").run(nowSeconds);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: SqliteOAuthStore,
    private readonly allowedRedirectHosts: string[],
    private readonly redirectUriAliases: RedirectUriAlias[] = [],
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const client = this.store.getClient(clientId);
    return client
      ? clientWithRedirectUriAliases(client, this.redirectUriAliases, this.allowedRedirectHosts)
      : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
  device_bound: number;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
    deviceBound: row.device_bound === 1,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
  device_bound: number;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
    deviceBound: row.device_bound === 1,
  };
}
