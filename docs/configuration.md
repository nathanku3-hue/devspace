# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval when enrolled-PC authorization is disabled. Must be at least 16 characters. |
| `DEVSPACE_DEVICE_AUTH` | Enables silent enrolled-PC OAuth authorization through a loopback signer. |
| `DEVSPACE_MCP_TRANSPORT_MODE` | MCP HTTP transport mode: `stateless` (default) or `stateful`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_SHELL` | Optional absolute path to the workspace Bash executable. On Windows, Git Bash next to `git.exe` is used when this is unset. |

## MCP HTTP transport

`DEVSPACE_MCP_TRANSPORT_MODE=stateless` is the default. Each MCP HTTP request
gets a fresh SDK transport/server wrapper while DevSpace's durable application
state remains in the shared workspace, review, long-task, and SQLite stores.
This avoids retaining one heavyweight MCP server instance per remote session
and prevents high-churn clients such as Chatshare from filling the retained
session pool and evicting other conversations.

Set `DEVSPACE_MCP_TRANSPORT_MODE=stateful` only for a client that specifically
requires retained Streamable HTTP sessions. The compatibility mode keeps the
64-session OOM guard and 30-minute idle cleanup. At capacity it reclaims only
sessions already past the idle threshold; otherwise it rejects the new
initialization rather than closing a still-valid existing session.

## OAuth

DevSpace uses a single-user OAuth approval flow. It can use either the Owner
password or a silent proof from the enrolled PC.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,chatshare.xyz,localhost,127.0.0.1` |

### ChatShare browser account pinning

The DevSpace ChatShare browser runner stores its selected ChatGPT Pro `carID` in
`localStorage` under `devspace:chatshare:pinned-car-id`, separately from ChatShare\'s
mutable `crtUse` preference. On the first run it pins the existing preference
(or selects the first eligible Pro account if none is selected). Subsequent
launches refuse to silently fall back to a different account if the pinned
account becomes unavailable, or if another tab switches `crtUse`. This avoids
starting a connector OAuth flow under a different underlying account while the
outer ChatShare login remains active.

To intentionally change accounts, first disconnect the existing DevSpace link
under its original ChatShare-backed account and complete any pending OAuth
attempts. In the **dedicated DevSpace ChatShare browser profile**, clear only
`localStorage.removeItem("devspace:chatshare:pinned-car-id")`, select the intended
account, then create a fresh authorization. Do not replay a rejected callback.
This protects the DevSpace-controlled browser path; it cannot repair a ChatShare
server-side ownership mismatch or an OAuth callback initiated in an unrelated
Chrome profile.

### Silent Enrolled-PC Authorization

| Variable | Default |
| --- | --- |
| `DEVSPACE_DEVICE_AUTH` | `0` |
| `DEVSPACE_DEVICE_AUTH_REQUIRED` | `0` |
| `DEVSPACE_DEVICE_AUTH_LOOPBACK_PORT` | `7677` |
| `DEVSPACE_DEVICE_AUTH_EXTENSION_ID` | Bundled extension ID |
| `DEVSPACE_DEVICE_AUTH_ALLOWED_REDIRECT_PREFIXES` | Chatshare OAuth callback prefixes |
| `DEVSPACE_DEVICE_AUTH_CHALLENGE_TTL_SECONDS` | `60` |

When enabled, DevSpace starts a signer on `127.0.0.1` only. The bundled Chrome
extension relays a one-time authorization challenge to that signer. The proof is
bound to the complete OAuth request and cannot be replayed. No local IP, MAC
address, cookie, or browser fingerprint is used as the identity.

When `DEVSPACE_DEVICE_AUTH_REQUIRED=1`, authorization requests outside the
configured redirect prefixes are rejected, and access or refresh tokens issued
without device proof are rejected. When it is `0`, the configured redirect
prefixes still use the enrolled-PC proof, while other allowed OAuth callbacks
use the normal Owner password approval flow.

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/.well-known/openid-configuration
```

## Tool Modes

`DEVSPACE_TOOL_NAMING` controls tool names.

| Value | Behavior |
| --- | --- |
| `short` | Default. Uses `read`, `edit`, `bash`, and related names. |
| `legacy` | Uses `read_file`, `edit_file`, `run_shell`, and related names. |

The batched text reader is always named `read_files` in both naming modes.

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Disables dedicated search and list tools. `read_files` remains available for bounded multi-file context reads; clients use the shell tool with `rg`, `grep`, `find`, `ls`, or `tree` for discovery. |
| `full` | Enables dedicated `grep`, `glob`, and `ls` tools. |

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated skill directories. |

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.codex/skills,$HOME/.claude/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_TOOL_NAMING="short" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.

## Managed Worktrees

DevSpace does not use a global worktree directory. Each managed worktree is
created below the owning repository at:

```text
<repository>/.worktrees/devspace-<random-id>
```

Before worktree mode can be used, the repository-local Git exclude must ignore
that directory. Add this line to the owning repository's common
`.git/info/exclude` file:

```text
/.worktrees/
```

DevSpace fails closed when `.worktrees` is not ignored, resolves outside the
repository through a symlink or Windows junction, or is already registered to a
conflicting worktree. Use `close_workspace` to retire sessions. It removes clean
managed worktrees through Git, refuses dirty worktrees, and requires explicit
confirmation before pruning Git-validated stale metadata for a missing path.
