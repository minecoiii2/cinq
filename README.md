# Cinq

Live two-way sync between Roblox Studio and your file system, built for editing with external editors and AI agents.

- Scripts anywhere in ReplicatedStorage, ReplicatedFirst, ServerScriptService, ServerStorage, StarterPlayer, StarterGui, StarterPack, Lighting and SoundService, including under GUIs, Parts, Tools and other non-Folder instances
- Edits flow both ways instantly, and edits to different parts of the same script on both sides at once are merged line by line
- Any instance name works on disk (`Weird/Name` → `Weird%2FName.luau`), and duplicate sibling names are disambiguated
- Renames and moves on disk keep the instance's identity, attributes and tags
- Tag anything `Cinq_Ignore` to keep it and its descendants out of sync, live; packages are skipped automatically so they never show as modified
- Disk deletes and creates are undoable in Studio, and a guard stops mass deletes
- A change journal records every edit with diffs and who made it, including what teammates changed while you were away: `cinq changes --since 12h`
- Type checking with luau-lsp from a generated sourcemap that's kept current, reporting only new problems; the same sourcemap gives VS Code full Luau support
- Sync ids are stored per Studio user, so teammates can all run Cinq on the same Team Create place
- A CLI with Studio tools for AI agents: Output, instance tree, selector search, property inspection, searching, reading and editing any script, the user's current selection, and running Luau, all with compact output and paths that handle any instance name

## Setup

1. Install [Node.js](https://nodejs.org) 20+, clone this repo, and run `npm link` in it so `cinq` works from any terminal.
2. Install the plugin: download `Cinq.rbxm` from the [latest release](https://github.com/minecoiii2/cinq/releases/latest) into your Studio plugins folder (Plugins tab → Plugins Folder), or build and install it from source with `install-plugin.bat` (`cinq install-plugin`).
3. Start the server: double-click `cinq.bat` (or `cinq run`) to run it in a window, or `cinq start` to run it in the background without one (`cinq stop` ends it). Every place syncs into one places folder (the `Cinq` folder in this repo unless you change it, see below) wherever you start it from, one server handles every open Studio, and it keeps your computer from sleeping (like PowerToys Awake, the screen can still turn off) until the terminal or Claude window that started it closes. The server itself keeps running and syncing after that. `cinq awake` turns the lock back on for your current terminal, `cinq awake off` drops it, and `--no-awake` skips it.
4. In Studio, click **Cinq** in the Plugins toolbar and allow the localhost request.

Each published place syncs into `<places folder>/<PlaceId>/`, and each unpublished file into `<places folder>/<file name>/`. Clicking **Cinq** turns syncing on or off for that place, and Studio remembers the choice per place, so enabled places reconnect automatically and new places are left alone. **Size** prints how much disk space the place's folder uses. **Activity** opens a panel listing changes that arrive from disk (with how many lines changed and where), conflicts and refused changes; click one to open the script at that line. Studio sends its changes at most once every 3 seconds; changes on disk reach Studio right away.

### Where places sync

- `cinq config root D:\Roblox\Places` syncs every place into that folder from now on, moving the ones already synced (`cinq config root --reset` goes back to the default).
- `cinq link <place> <folder>` gives one place its own folder, for example inside the game's git repo so its scripts are versioned with it. The place's files and history move there, and other files in that folder are left alone; add `.cinq/` and `sourcemap.json` to that repo's `.gitignore`. A PlaceId that hasn't synced yet can be linked too. `cinq unlink <place>` moves it back (`--keep` leaves the files).
- `cinq config` shows both. Settings live in `~/.cinq/config.json`, outside the repo, so updating Cinq never touches them. Changing them stops and restarts a running server; Studio reconnects on its own.

## CLI

`cinq <command>` after running `npm link` once in this folder (or `cinq.bat <command>` / `node server/cli.js <command>` without it):

| Command | What it does |
| --- | --- |
| `run [root]` | Start the sync server in this window (also what a double-click does); `root` overrides where the `Cinq` folder lives |
| `start [root]` / `stop` | Start the server in the background, or stop it |
| `awake [off]` | Keep the computer awake until this terminal (or Claude) closes, or stop doing so |
| `status` | Whether the server is running and which Studios are connected |
| `config`, `config root <folder>` | Where places sync, and change it |
| `link <place> <folder>`, `unlink <place>` | Give one place its own folder, or move it back |
| `places` | Synced places with their names, script count and size |
| `size [place]` | Disk space used by a place, by name or PlaceId |
| `changes [--since 12h]` | The change journal, with diffs and who made each change |
| `conflicts` | Open conflicts with what each side changed; `conflicts resolve <id>` clears one |
| `wait` | Wait until Studio and disk have every pending change |
| `backup [place]` | Copy a place's synced scripts into `Cinq/.backups/<place>/<date_time>/`; `backup list` shows them |
| `log [-n 30]` | Recent server log (`--warnings`, `--errors`, `--grep`) |
| `install-plugin` | Build `dist/Cinq.rbxm` and install it into Studio (`--mirror <place>` also copies it into that place) |
| `console [-n 50]` | Recent Studio Output (`--errors`, `--warnings`, `--grep`, `--full`); errors in synced scripts point at the file and line |
| `tree [path] [-d 2]` | The instance tree under a path |
| `find <selector>` | QueryDescendants search (`--in <path>`) |
| `inspect <path>` | Non-default properties, attributes, tags and children (`--all`) |
| `sourcemap [place]` | Write the place's `sourcemap.json` for luau-lsp (kept current after) |
| `check [paths]` | Type-check and lint with luau-lsp, reporting only problems that are new since the baseline |
| `drafts [path]` | In Drafts mode, scripts whose draft differs from the committed version and whether a newer commit landed on them (`--diff`, `--merge` 3-way merges clean ones into your draft) |
| `open <file>[:line]` | Open a synced file's script in Studio's editor at a line (or select any instance path in the Explorer) |
| `selection` | What's selected in the Explorer, the focused script with the cursor or selected lines, and the open tabs |
| `grep <text>` | Search every script in Studio, synced or not (`--in`, `-i`, `--lua`) |
| `read <path>` | Any script's source as the editor has it (drafts included), with line numbers (`--from`, `--to`) |
| `edit <path>` | Replace text in any script (`--old`, `--new`, `--all`, or a JSON list of edits); all edits apply or none do |
| `exec <file>`, `exec -e <code>` | Run Luau in Studio and print its output, as one undoable step |

Studio tools take `-p <part of a name or PlaceId>` when several Studios are connected. Paths use dots or slashes, and names that contain them go in brackets: `Workspace["Part.1"]["a/b"]`. Every tool prints paths the same way, so they can be pasted back in.

## Files

| On disk | In Studio |
| --- | --- |
| `Name.luau` | ModuleScript |
| `Name.server.luau`, `.client.luau`, `.legacy.luau`, `.plugin.luau` | Script with that RunContext |
| `Name.local.luau` | LocalScript |
| `Name/init.*.luau` | Script with children |
| `Name/` | Folder, or the existing container |

## Type checking and editor support

`cinq sourcemap` writes a Rojo-style `sourcemap.json` into the place's folder from the connected Studio: every instance in the synced services (plus the top of Workspace) with its class, synced scripts pointing at their files, and read-only copies in `.cinq/unsynced/` for scripts Cinq doesn't sync (packages, `Cinq_Ignore`), so requiring them still resolves. Cinq keeps it current as scripts are added, moved and removed, and adds a `.vscode/settings.json` so opening the place's folder in VS Code with the [Luau extension](https://marketplace.visualstudio.com/items?itemName=JohnnyMorganz.luau-lsp) gives types, autocomplete and go-to-definition across scripts.

`cinq check [paths]` refreshes the sourcemap and runs [luau-lsp](https://github.com/JohnnyMorganz/luau-lsp) `analyze` with the new type solver (the one Studio uses), reusing the extension's Roblox type definitions. The first full check records the existing problems as a baseline in `.cinq/check-baseline.json`; after that only new ones are reported (`--all` shows every one, `--baseline` records them again), so it's useful on large codebases that were never type-clean.

## License

[MIT](LICENSE)
