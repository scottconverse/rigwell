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

## Code-provider connections (spec 20.21)

Settings > Code providers connects GitHub and GitLab. Paste an access token to verify its account before saving it.
The page shows the signed-in account and the scopes reported by the provider. An absent scope response means
permissions are unknown, including GitHub fine-grained tokens; inspect permissions at the provider. A failed
replacement preserves the working credential. Disconnect removes local credentials and cancels pending sign-in;
it does not revoke a token at the provider.

Device sign-in reuses the normal OAuth manager and requires Rigwell's own registered public clients. The owner
must supply the real client IDs. Example user settings, with placeholders to replace:

```json
{
  "oauthProviders": {
    "github": {
      "clientId": "REGISTERED-RIGWELL-GITHUB-CLIENT-ID",
      "deviceAuthorizationEndpoint": "https://github.com/login/device/code",
      "tokenEndpoint": "https://github.com/login/oauth/access_token",
      "scopes": ["repo", "read:user"]
    },
    "gitlab": {
      "clientId": "REGISTERED-RIGWELL-GITLAB-CLIENT-ID",
      "deviceAuthorizationEndpoint": "https://gitlab.com/oauth/authorize_device",
      "tokenEndpoint": "https://gitlab.com/oauth/token",
      "scopes": ["api", "read_user"]
    }
  }
}
```

Enable the device flow on the registered application. The page displays its verification URL and code; opening
that URL is a user action. Cancelling an attempt preserves the previous connection. OAuth tokens refresh through
the existing manager. Token connections use credential names `github` and `gitlab`; OAuth uses `oauth:github`
and `oauth:gitlab`. Tokens never return through the code-provider protocol. `create_pr` and PR status reuse this
connection for their API fallback; installed `gh` or `glab` keeps its existing priority and receives a connected
credential through its child process environment, never command arguments. Without a connected credential the
CLI keeps its own authentication. Git pushes use the machine's
Git authentication, so configure that separately if needed. Later review, triggers and share use the same resolver.

Protocol methods: `code_provider_list {}`, `code_provider_connect {provider, token}`,
`code_provider_disconnect {provider}`, `code_provider_login_start {provider}`,
`code_provider_login_status {provider, loginId}`, and `code_provider_login_cancel {provider, loginId}`.
`provider` is `github` or `gitlab`. List/status responses contain account and scope metadata, never credentials.
The daemon owns the device poll; clients poll its status and can reconnect without taking ownership of the login.

Provider references: [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[GitHub scope reporting](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[GitLab OAuth](https://docs.gitlab.com/api/oauth2/) and
[GitLab personal access token metadata](https://docs.gitlab.com/api/personal_access_tokens/).


## Guided model setup (spec 20.2)

With no configured models, the Home page offers account sign-in first, followed by model configuration and API-key
storage. An absent registered client is shown as not available. No client IDs are borrowed from installed coding
clients. API keys and signed-in coding CLI sessions are different credentials; neither supplies Rigwell's own
public OAuth client registration. Registered built-in entries and real provider sign-in remain pending those IDs.

Settings > Accounts supports sign-in, sign-in again and sign-out. Reauthorization is available even when a saved
token remains, so an expired or revoked account can be renewed. Tokens refresh in the daemon before expiry; a
refused refresh reports a non-retryable authentication error. Stopping the page's waiting operation does not revoke
a login already completed at the provider.

Settings > Custom Models supports Anthropic Messages, OpenAI Responses, native Google, Chat Completions (including
local Ollama-compatible endpoints), and Bedrock Converse. Choose an available account in Authentication to save
only its credentialSource name; that choice cannot be combined with an API key. Google sends the refreshed account
token in its configured header, and rejects a signed-out account before contacting the model endpoint. Bedrock
supports region plus automatic credentials, an AWS profile, bearer token, access keys or credential commands.
Editing a model preserves its other adapter/profile options. No model or provider is selected globally by setup.

Stored API keys, helper commands, OAuth client secrets and Bedrock secret fields are masked before user settings
reach a renderer and restored when their unchanged masks are saved. Environment references remain readable. Use the
API keys page and keychain references, or existing AWS profiles/environment references, instead of duplicating a
secret into each model entry.

Real sign-in availability and account-plan coverage depend on the provider's registered-client offering. See
[provider sign-in guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) and
[Google's own-client OAuth setup](https://ai.google.dev/gemini-api/docs/oauth). Fake authorization/model servers test
the implementation; those tests do not prove that a real subscription is enabled for Rigwell.
