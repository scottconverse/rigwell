# Connector catalog

Open a session's Connectors dialog and choose Catalog. Search by name or description, filter by category,
then choose Add. Entries with inputs ask for the required values. OAuth entries start sign-in and show a link
and completion status; the daemon does not open a browser itself. Installed servers remain in the Installed tab.

The bundled catalog is src/mcp/connectors.json. It configures public MCP servers run by
[Linear](https://linear.app/docs/mcp), [Notion](https://developers.notion.com/guides/mcp/get-started-with-mcp)
and [Sentry](https://mcp.sentry.dev/). Rigwell does not host these services. Their accounts and access rules apply.

Additional catalog sources are saved in user settings as mcpCatalogUrls. Enter one HTTPS JSON URL or absolute
JSON file path per line in Catalog, then save. For a JSON file in a remote Git repository, use its raw-file URL.
A local Git checkout's absolute JSON path also works. Sources are fetched only when Catalog opens, including
after leaving and reopening that tab. Saving sources does not fetch them, and startup does not fetch them.
HTTP is allowed only for loopback services. Redirects are refused. Each source is limited to 512 KiB and 256
entries; there can be up to 16 additional sources. Invalid sources produce warnings without hiding bundled entries.

A source contains either an array of entries or an object with a connectors array:

~~~json
{
  "connectors": [{
    "name": "team-tools",
    "description": "Tools for a team's workspace",
    "category": "Development",
    "transport": "http",
    "url": "https://tools.example/mcp/{{workspace}}",
    "auth": "token",
    "docs": "https://tools.example/docs",
    "headers": { "authorization": "Bearer {{token}}" },
    "inputs": [
      { "name": "workspace", "label": "Workspace" },
      { "name": "token", "label": "API token", "secret": true }
    ]
  }]
}
~~~

transport is http, sse or stdio. Remote entries use url and optional headers. Command entries use command,
an args array and optional env. Arguments stay separate and are passed directly without a shell. auth is none,
oauth or token; stdio entries cannot use OAuth. OAuth uses the server's discovery and registration flow described
in [auth.md](auth.md). name uses letters, digits, hyphens and underscores. description, category and docs are required.

Inputs use literal {{name}} substitution. Values in URLs are percent encoded. Secret inputs are allowed only
in headers or env; expanded secret values use the existing credential store, and mcp.json receives keychain
references. Missing credential references fail without launching the process or sending the request. The store's
existing OS backend or private-file fallback applies. Do not put actual credentials in a published catalog.

Catalog entries are instructions offered by their publisher, including local commands. Check the displayed target,
source and linked documentation before choosing Add. Listing never runs a command or contacts its MCP endpoint.
Adding uses the displayed configuration snapshot, persists it in user mcp.json and starts that server. Existing
server names are preserved; a conflicting addition fails. For a different name, use the value form when available
or the manual Add MCP Server form on Installed.

The session protocol methods are mcp_catalog_list {sources?}, returning entries and warnings, and
mcp_catalog_add {key,values?,name?}. Keys refer only to the last displayed snapshot in that session. Reopen Catalog
if a key is stale. No catalog is added to the agent's tool registry, and tokens are not returned by these methods.
