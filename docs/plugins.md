# Plugins and marketplace indexes

Open **Plugins** in the desktop sidebar, or use `rigwell plugin`. No marketplace index is shipped or contacted by default. A plugin is a folder with `rigwell-plugin.json` and one or more contributions. Installation copies an immutable snapshot into the private Rigwell plugins folder; it does not edit the source folder or execute lifecycle scripts.

```json
{
  "name": "project-helper",
  "version": "1.0.0",
  "description": "Project instructions and tools",
  "skills": "skills",
  "agents": "agents",
  "commands": "commands",
  "hooks": "hooks.json",
  "mcp": "mcp.json",
  "automationTemplates": "templates.json"
}
```

All component fields are optional, but at least one usable contribution is required. Paths must remain inside the snapshot. Skills use the existing `skills/<name>/SKILL.md` format, agents and slash commands use Markdown files, hooks and MCP use their existing JSON formats, and templates are a JSON array using the same shape as built-in automation templates (`id`, `name`, `description`, `category`, `schedule`, `parameters`, `instructions`, `autonomy`). Unknown manifest fields, invalid assets, links and special files are rejected. Snapshots are bounded at 4,000 entries, 32 MiB total and 8 MiB per file, excluding Git checkout metadata. Plugin names use lowercase letters, digits and hyphens; versions use three numeric components with optional prerelease/build suffixes.

Use a local folder, or an HTTPS/SSH Git repository pinned to a full lowercase commit SHA. Git sources use a shallow fetch of that exact commit, disable checkout hooks and interactive credential prompts, and do not recurse into submodules. `subdir` can select a plugin within the repository. Use an existing noninteractive Git credential/SSH setup for private sources; credentials must not be embedded in URLs. Git operations have a bounded lifetime and shutdown cancels and awaits owned operations.

```text
rigwell plugin list
rigwell plugin install C:/code/my-plugin
rigwell plugin install https://example.test/team/plugins.git --commit <full-sha> --subdir helper
rigwell plugin update project-helper --commit <new-full-sha>
rigwell plugin update project-helper --source C:/code/my-plugin
rigwell plugin disable project-helper
rigwell plugin enable project-helper
rigwell plugin uninstall project-helper
```

Installation and update first show the actual contributions and required hook/MCP trust. Confirm the exact snapshot in the desktop dialog or interactive CLI. Headless CLI installation requires `--yes` after reviewing the preview; without it the command prints the preview and exits without installation. Enabling a disabled plugin requires the same trust preview. Canceling discards the staged snapshot. Approvals expire after fifteen minutes, and a changed staged snapshot is rejected. Installed files changed outside the manager are excluded from new sessions and marked changed/missing on the page. Updates preserve plugin identity and require a new preview; old immutable snapshots remain until uninstall so a loaded session can retain its assets. Uninstall disables first, then removes managed snapshots; if a Windows file lock prevents removal, the disabled record remains available for a later removal attempt.

Contributions apply to **new sessions**. Existing sessions retain their already loaded tools; close those sessions before uninstalling assets they use. Project/user skills, agents and commands take precedence over plugin names. MCP names and template IDs are prefixed with the plugin name. Org-managed hook restrictions still apply. No automation starts merely because its template was installed.

Approved plugin hooks and stdio MCP processes receive `RIGWELL_PLUGIN_ROOT`, pointing to the immutable installed snapshot. Project working directories retain their usual meaning. Portable scripts can locate assets through that environment variable. For example, an MCP entry can use `command: "node"` and `args: ["-e", "require(process.env.RIGWELL_PLUGIN_ROOT + '/server.cjs')"]`. Hook commands can invoke a corresponding script the same way, with normal platform shell quoting. Do not use the original checkout path, which may change after installation. MCP previews show command/arguments, URL, environment/header names and OAuth requirements; secret values are not displayed.

An index is a JSON file in a user-chosen local checkout or pinned Git repository. The default filename is `rigwell-marketplace.json`:

```json
{
  "plugins": [
    {
      "name": "project-helper",
      "source": "https://example.test/team/plugins.git",
      "commit": "0123456789012345678901234567890123456789",
      "subdir": "helper",
      "description": "Project helper"
    }
  ]
}
```

```text
rigwell plugin index-add team https://example.test/team/index.git --commit <full-sha>
rigwell plugin index-add local C:/code/plugin-index --file indexes/team.json
rigwell plugin install-index team project-helper
rigwell plugin index-remove team
```

The desktop uses the source fields to add or refresh a named index and lists its pinned entries. Index registration loads only inert data and never installs its plugins. Each selected entry is fetched, validated and previewed separately, and its manifest identity must match the index. Refresh is explicit; changing an index does not update an installed plugin. Removing an index does not uninstall its plugins. Limits are thirty indexes, one hundred entries per index and one hundred installed plugins.

Acceptance uses local bare Git repositories, fake MCP/provider processes and headless production UI. It proves pinned updates and marketplace selection, no execution before trust, source/staged/installed mutation boundaries, link/path refusal, private storage, precedence and managed-hook policy, actual hook/MCP execution, a real Session consuming a plugin skill, and desktop/CLI lifecycle controls. No real marketplace, remote Git credential flow or installed application acceptance is inferred.
