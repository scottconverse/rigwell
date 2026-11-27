# Rigwell 0.5.2 on Windows

Windows x64 moves to **0.5.2**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.5.2/rigwell-setup-0.5.2-x64.exe)
- [Release assets, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.5.2)
- [User manual](user-manual.md) and [installation guide](install.md)

## Set up models

A new page, Settings > Set up models, helps you connect a model. Home and Settings > Custom Models have a Set up models button.

- **Local servers.** Rigwell looks for LM Studio, Ollama and llama.cpp on this computer and lists their models. Use this one saves the model as a custom model.
- **Sign-ins.** The page shows whether Claude Code and Codex are signed in. A sign-in shows its link and one-time code, with Copy and Cancel. A signed-in client model can be saved with one click.
- **Ollama.** The page shows whether Ollama is running and signed in, and can start the Ollama sign-in.
- **API connection.** Enter a name, base URL and key. Discover models lists the models of that service. Test sends one short request. The key is kept in the credential store, not in the settings file.
- A saved key is sent only to the base URL it was saved with. Discover and Test do not follow redirects and stop on a time limit.
- A model that is already saved shows "Already saved." The page shows which models Rigwell uses now.

## Windows installer

- Every program file in the installer is signed by Scott Converse, including the installer plugins. Smart App Control blocked the unsigned plugins before.
- If the program file is missing after the unpack, the installer removes its shortcuts and registry entries, shows an error and exits with code 2.
- The first-run Connect a model panel stacks its parts instead of squeezing them into columns.

## Known limits

- The Set up models page was checked in the development app. It was not checked in the packaged app.
- No new sign-in was finished end to end from the page. Cancel was checked for Claude Code and Codex.
- "Use whatever model is loaded" is not offered. Pick a model by name.
- A saved local model shows only its model id as its name.
- When a connection gets a new key, the old key stays in the credential store.
- The known limits in the [0.5.1 release notes](release-0.5.1.md) and [0.5.0 release notes](release-0.5.0.md) still apply.

The [0.5.1 release notes](release-0.5.1.md) describe the preceding release.
