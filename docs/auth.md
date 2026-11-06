# Sign-in with an account plan, secrets and environments

## A note on terms of use

Rigwell ships no provider entries, no client ids and does not identify itself as any other application. Whether a
subscription or account plan may be used from a third-party app, and with which OAuth client, is decided by that
provider's terms. Read them before you set this up. Rigwell only implements the standard OAuth 2.0 mechanics; you bring
your own registered client.

## OAuth sign-in (spec 12.2 `credentialSource`)

A custom model with `credentialSource: "<name>"` gets its bearer token from the OAuth sign-in stored under that name,
instead of an `apiKey`. `credentialSource` cannot be combined with `apiKey` or `apiKeyHelper`: such an entry is
reported invalid (`rigwell` shows it disabled with the reason in `list_models` with `includeDisabled`).

### 1. Describe the provider in `settings.json`

Register your own OAuth client with the provider (a public client with a loopback redirect `http://127.0.0.1:<port>/callback`
is typical), then add:

```json
{
  "oauthProviders": {
    "my-plan": {
      "clientId": "YOUR-OWN-CLIENT-ID",
      "authorizationEndpoint": "https://auth.example.com/oauth/authorize",
      "tokenEndpoint": "https://auth.example.com/oauth/token",
      "deviceAuthorizationEndpoint": "https://auth.example.com/oauth/device",
      "scopes": ["models.read"],
      "apiBaseUrl": "https://api.example.com"
    }
  },
  "customModels": [
    { "model": "some-model", "displayName": "Plan model", "provider": "openai", "credentialSource": "my-plan" }
  ]
}
```

Fields of an `oauthProviders` entry:

| Field | Meaning |
|---|---|
| `clientId` | Required. Your own registered client. |
| `clientSecret` | Only for confidential clients. `${ENV_VAR}` or `keychain:<name>` (see `rigwell credential`). |
| `tokenAuthMethod` | `none` (default without a secret), `client_secret_post` (default with a secret) or `client_secret_basic`. |
| `authorizationEndpoint` | Needed for the browser flow. |
| `tokenEndpoint` | Required. |
| `deviceAuthorizationEndpoint` | Needed for the device flow (RFC 8628). |
| `scopes` | Array of scope strings. |
| `redirectPort`, `redirectPath` | Fixed loopback port (default: any free port) and path (default `/callback`), for providers that need an exact registered redirect URI. |
| `authParams` | Extra query parameters on the authorization request. |
| `apiBaseUrl` | Used as the model's `baseUrl` when the model entry has none. |
| `tokenHeader`, `tokenScheme` | How the access token is sent. Default header `authorization`, scheme `Bearer`. Scheme `""` sends the bare token. |

All endpoints must be `https` (plain `http` only for `127.0.0.1` or `localhost`). Provider settings from project
settings load only for trusted folders, like hooks.

### 2. Sign in

```
rigwell auth login my-plan            # browser flow: prints a URL, waits for the redirect on 127.0.0.1
rigwell auth login my-plan --device   # device flow: prints a code and a URL to open on any device
rigwell auth status                   # signed in / expired per provider (no tokens are printed)
rigwell auth logout my-plan           # removes the stored tokens
```

The browser flow is the authorization code grant with PKCE (S256) and a random `state`; the loopback server listens on
127.0.0.1 only, accepts a single matching redirect and stops afterwards. A login times out after 5 minutes.

Tokens are stored as JSON in the credential store under `oauth:<name>` (macOS Keychain, libsecret, else the 0600
`credentials.json`). Before each model request the token is refreshed when it expires within 60 seconds (one refresh
at a time per provider, the refresh token is kept when the provider does not rotate it). When the provider refuses the
refresh (revoked or expired), the request fails with an `auth` error telling you to run `rigwell auth login <name>`.
`logout` deletes the tokens locally; it does not call a revocation endpoint.

### Protocol methods (for clients)

Names carry the `rigwell.` prefix. No result ever contains a token.

- `auth_list {}` returns `{ providers: [{ name, loggedIn, expiresAt?, expired?, hasRefreshToken?, scope?, scopes, apiBaseUrl?, browserLogin, deviceLogin }], problems: string[] }`.
- `auth_login_start { name, mode? }` (`mode`: `"browser"` or `"device"`; default browser when the provider has an authorization endpoint, else device) returns a status:
  `{ loginId, name, kind, state: "pending", expiresAt, url? }` for the browser flow (open `url`), or
  `{ ..., userCode, verificationUri, verificationUriComplete? }` for the device flow (show the code).
- `auth_login_status { loginId }` returns the same object with `state` `pending`, `complete`, `failed` (with `error`) or `cancelled`. Poll it every second or two.
- `auth_logout { name }` returns `{ loggedOut: boolean }`.

## MCP server sign-in (OAuth)

An http or sse MCP server can require OAuth sign-in (MCP authorization, protocol version `2025-06-18`). When such a
server answers 401, Rigwell shows it as failed with "Sign-in needed: run `rigwell mcp login <name>`". Nothing is
registered and no browser opens until you ask.

```
rigwell mcp login acme    # finds the sign-in server, prints a URL, waits for the redirect on 127.0.0.1
rigwell mcp status        # signed in / not signed in / OAuth off, per http and sse server in mcp.json
rigwell mcp logout acme   # removes the stored token
```

What `login` does:

1. Reads the protected resource metadata (RFC 9728): the `resource_metadata` URL in the 401 `WWW-Authenticate`
   header, else `/.well-known/oauth-protected-resource<path>`, else the same at the root.
2. Reads the authorization server metadata (RFC 8414, else OpenID discovery) of the first listed authorization server.
   Every endpoint must be https (http only on 127.0.0.1 or localhost). If the server lists its PKCE methods and S256
   is not one of them, sign-in is refused.
3. Picks a client: `oauth.clientId` from `mcp.json`; else `oauth.clientMetadataUrl` when the server supports client
   metadata documents; else the app Rigwell registered before for this server; else a new dynamic client
   registration (RFC 7591) with a `http://127.0.0.1:<port>/callback` redirect and no client secret.
4. Runs the browser sign-in (authorization code with PKCE S256, as above). Every authorization and token request
   carries the server as the RFC 8707 `resource`.

After a sign-in started with `mcp_auth_start`, that session reconnects the server. After `rigwell mcp login` in a
terminal, a session that is already open connects the server at its next start. Tokens are stored under `oauth:mcp.<name>`, the
discovery result and the client under `mcp-oauth:<name>` (both in the credential store). A token is refreshed before
it expires; when the refresh is refused, the server shows "The sign-in expired" again. `logout` removes the token and
keeps the registered app, so the next `login` does not register again.

Options in the server's `mcp.json` entry:

```json
{ "mcpServers": { "acme": { "type": "http", "url": "https://mcp.acme.example/mcp",
  "oauth": { "scopes": ["tools.read"], "clientId": "my-app" } } } }
```

- `oauth: false` turns OAuth off for the server. An `Authorization` header in `headers` also turns it off (the header
  is sent as it is), and a 401 is then a plain error.
- `oauth.scopes` (default: the header's `scope`, else the metadata's `scopes_supported`), `oauth.resource` (default:
  the metadata's `resource`, else the server URL), `oauth.authorizationServerIssuer` (for a server that publishes no
  metadata), `oauth.clientId`, `oauth.clientSecret` (only for a confidential client; it is stored in `mcp.json` as
  written), `oauth.clientMetadataUrl`.
- A 403 is a plain error, not a sign-in request.

Protocol methods: `mcp_auth_start { serverName }` returns the same login status as `auth_login_start` (open `url`,
then poll `auth_login_status { loginId }`); `mcp_auth_logout { serverName }` returns `{ success }`. `list_mcp_servers`
shows `requiresAuth` and `hasAuthTokens` for servers with OAuth on. No result contains a token.

Desktop app: the Connectors dialog (the Connectors chip in the message box) and Settings > Connectors show a "Sign in"
button for a server that needs sign-in, and "Sign out" for a server with a stored token. Sign in opens the sign-in page
in your browser and waits. From the Connectors dialog, the open session connects the server when you finish. From
Settings > Connectors, other open sessions connect it at their next start. The TUI has no button: run the terminal
command (decision 347).

## Secrets

Named secrets (API keys, tokens). Values live only in the credential store under `secret:<name>`; a custom model can
use one as `apiKey: "keychain:secret:<name>"`. `<home>/secrets.json` (0600) is an index of names and masks.

A mask is `****` plus the last four characters for values of 12 or more characters, else `****`. Lists never return
values; there is no method that reads a value back.

- `list_secrets {}` returns `{ secrets: [{ name, mask, createdAt, updatedAt, usedBy: [environment names] }] }`.
- `set_secret { name, value }` returns `{ name, mask, backend }` (creates or replaces). Names: 1-64 of letters, digits, `.`, `_`, `-`.
- `delete_secret { name }` returns `{ deleted, usedBy }` (environments that still point at it show the secret as missing).

## Environments

A named set of variables for a session's commands. Each variable is a literal string or a reference
`{ "secret": "<secret name>" }`. Stored in `<home>/environments.json` (0600), which holds names and literals only.

- `list_environments {}` returns `{ environments: [{ name, description?, updatedAt, vars: [{ name, kind: "literal", value } | { name, kind: "secret", secret, missing }] }] }`. Literal values are shown, so put sensitive values in secrets.
- `set_environment { name, vars, description? }` replaces the whole environment. `vars` is `{ "NAME": "literal" | { "secret": "x" } }`. Variable names match `[A-Za-z_][A-Za-z0-9_]*`; the protected names (`HOME`, `LD_PRELOAD`, `SHELL`, ...) are refused.
- `delete_environment { name }` returns `{ deleted }`.

Use one with `initialize_session { environment: "<name>" }` (an unknown name, or a missing secret, fails the call before
the session is created). The variables are added to the environment of Execute commands, background jobs and hook
commands. They are never written into the prompt or the transcript. The session settings file stores only the
environment's name, and `load_session` applies it again by name.

Redaction: the exact secret values of the environment are replaced by `[secret:<name>]` in tool results (so a command
that prints one does not put it into the transcript or the model's context) and in every outgoing notification. This
matches the value as written; an encoded or split copy (base64, one character per line) is not caught.

## Sign-in from the desktop app and the terminal

Desktop: Settings > Accounts lists the providers from `auth_list`, starts the browser or device-code sign-in, polls the status and signs out. Terminal: `/login [provider] [--device]` and `/logout [provider]`. Settings > API keys and Environments edit the secrets and environments below; stored values are never displayed.
