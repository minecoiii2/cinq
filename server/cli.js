#!/usr/bin/env node
"use strict"

const fs = require("fs")
const { spawn, spawnSync } = require("child_process")
const path = require("path")
const { PORT } = require("./index")
const { SYNC_FOLDER, CONFIG_FILE, DEFAULT_PLACES_DIR, readConfig, writeConfig, placesDir, placeKey, listPlaceDirs, folderSize } = require("./places")
const { listConflicts, describeConflict, resolveConflict } = require("./conflicts")
const { findOwner } = require("./owner")
const { SOURCEMAP_FILE } = require("./sourcemap")
const { displayPath } = require("./check")

const BOOLEAN_FLAGS = new Set(["errors", "warnings", "full", "all", "json", "no-diff", "no-install", "no-awake", "ignore-case", "lua", "no-refresh", "baseline", "diff", "merge", "reset", "keep"])
const ALIASES = { n: "lines", e: "code", d: "depth", p: "place", i: "ignore-case" }

const HELP = `Cinq, two-way sync between Roblox Studio and your files

Usage: cinq <command> [options]

  run [folder]              Start the sync server in this window (the default when no command is given); places
                            sync into the configured places folder unless a folder is given
  start [folder]            Start the server in the background, without a window; it keeps running after
                            the terminal or Claude closes
  config                    Where places sync and which places are linked to their own folders
  config root <folder>      Sync places into this folder from now on, moving the existing ones (--reset for
                            the default, the Cinq folder next to the app)
  link <place> <folder>     Give one place its own folder, e.g. inside a game's git repo, moving its files and
                            history there (a PlaceId that hasn't synced yet works too)
  unlink <place>            Move a linked place back into the places folder (--keep leaves its files)
  stop                      Stop the server
  awake [off]               Keep the computer from sleeping until this terminal (or Claude) closes, or stop.
                            run and start turn this on unless --no-awake
  status                    Is the server running, and which Studios are connected
  places                    Synced places (published ones by PlaceId) with script count and size
  size [place]              Disk space used by one place (PlaceId or name), or all of them
  changes [--since 12h]     What changed, with diffs (--place, --origin studio|disk, --no-diff)
  conflicts [--place p]     Open conflicts with what each side changed (--no-diff)
  conflicts resolve <id>    Clear a conflict once it's merged (--all clears every listed one)
  log [-n 30]               Recent server log (--warnings, --errors, --grep <text>, --place)
  wait [--timeout 15]       Wait until Studio has every pending change, both ways (all places, or --place)
  backup [place]            Copy a place's synced scripts (or every place's) into Cinq/.backups
  backup list [place]       Existing backups with their size
  sourcemap [place]         Write a Rojo-style sourcemap.json into the place's folder from the connected Studio,
                            so luau-lsp (VS Code, cinq check) understands requires and instances; kept current after
  check [paths]             Type-check and lint a place's files (or just these) with luau-lsp, refreshing the
                            sourcemap first (-n 50, --full, --no-refresh, --defs <file>)
  install-plugin            Build dist/Cinq.rbxm and install it into Studio (--no-install to only build)
                            --mirror <place> also writes it into that place's ServerScriptService.CinqPlugin

Studio tools (talk to a connected Studio; add --place <name|PlaceId> when several are open):
  console [-n 50]           Recent Output lines (--errors, --warnings, --grep <text>, --full)
  tree [path] [-d 2]        Instance tree, e.g. cinq tree ReplicatedStorage.Modules
  find <selector>           QueryDescendants search, e.g. cinq find ".Cinq_Ignore" --in ServerScriptService
  inspect <path>            Properties that differ from defaults, attributes, tags, children (--all)
  drafts [path]             Drafts mode: scripts whose draft differs from the committed version, and whether a
                            newer commit landed on them (--diff shows each side, --merge 3-way merges clean ones
                            into your draft; then click Merge and Commit in View → Drafts)
  open <file>[:line]        Open a synced file's script in Studio's editor at a line, or any instance path
                            (scripts open, other instances get selected in the Explorer)
  selection                 What's selected in the Explorer, the focused script with the cursor or selected
                            lines, and the other open script tabs
  grep <text>               Search every script in Studio, synced or not (--in <path>, -i, --lua for a Lua
                            pattern, --limit 100); synced scripts show their file
  read <path>               Any script's source as Studio's editor has it, with line numbers (--from, --to)
  edit <path>               Replace text in any script: --old <text> --new <text> [--all], or a JSON file
                            (or - for stdin) of [{"old", "new", "all"}]; every edit applies or none do
  exec <file> | -e <code>   Run Luau in the edit DataModel and print its output (undoable)

Paths separate names with dots or slashes (ReplicatedStorage.Modules.Spring, game/Workspace/Map).
Names containing . / or [ go in brackets: Workspace["Part.1"]["a/b"], or Workspace[Part.1] when the
shell strips quotes. Output prints paths the same way, so they can be pasted back in.`

function parse(argv) {
	const args = { _: [] }
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i]
		const match = /^--?([a-z-]+)$/i.exec(raw)
		if (!match) {
			args._.push(raw)
			continue
		}
		const name = ALIASES[match[1]] ?? match[1]
		if (BOOLEAN_FLAGS.has(name)) args[name] = true
		else args[name] = argv[++i]
	}
	return args
}

async function health() {
	try {
		return await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()
	} catch {
		return null
	}
}

// The folder places sync into, as the running server sees it (it may have been started with another one).
async function placesDirOf(args) {
	if (args.root) return path.resolve(args.root)
	const running = await health()
	if (running?.placesDir) return running.placesDir
	if (running?.root) return path.join(running.root, SYNC_FOLDER)
	return placesDir()
}

function readState(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, ".cinq", "state.json"), "utf8"))
	} catch {
		return null
	}
}

function listPlaces(base) {
	return listPlaceDirs(base).map(({ dir, name, linked }) => {
		const state = readState(dir)
		const placeId = String(state?.placeId ?? (/^d+$/.test(linked || "") ? linked : "?"))
		const named = placeId !== "0" && state?.placeName && state.placeName !== name ? `${name} "${state.placeName}"` : name
		const label = linked ? `${named} (linked: ${dir})` : named
		return { name, label, placeName: state?.placeName ?? name, dir, placeId, linked, scripts: Object.keys(state?.scripts ?? {}).length }
	})
}

function matchPlace(places, wanted) {
	const needle = String(wanted).toLowerCase()
	const exact = places.filter((p) => [p.name, p.placeName, p.placeId, p.linked || ""].some((v) => v.toLowerCase() === needle))
	const matches = exact.length > 0 ? exact : places.filter((p) => [p.name, p.placeName].some((v) => v.toLowerCase().includes(needle)))
	if (matches.length === 1) return matches[0]
	console.error(matches.length === 0 ? `No synced place matches "${wanted}" (see cinq places)` : `"${wanted}" matches several places, nothing was done. Use more of the name or the PlaceId: ${matches.map((p) => p.label).join(", ")}`)
	process.exit(1)
}

// Windows kills every process in a job when the job's owner exits, and apps like Claude run their children (detached
// ones included) in such a job. WMI creates the process itself, so the server isn't in that job and outlives the app.
function startOutsideJob(command) {
	const script = [
		"$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
		"$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CINQ_COMMAND; CurrentDirectory = $env:CINQ_CWD; ProcessStartupInformation = $startup }",
		"exit $result.ReturnValue",
	].join("; ")
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		env: { ...process.env, CINQ_COMMAND: command.map((part) => `"${part}"`).join(" "), CINQ_CWD: process.cwd() },
		windowsHide: true,
		encoding: "utf8",
	})
	if (result.status !== 0) {
		console.error(`Couldn't start the server (WMI returned ${result.status}): ${result.stderr.trim()}`)
		process.exit(1)
	}
}

// A place from --place, from the paths given (or the current folder) when they're inside one, or the only connected Studio.
async function pickPlace(args, paths = []) {
	const places = listPlaces(await placesDirOf(args))
	if (args.place) return matchPlace(places, args.place)
	for (const hint of paths.length > 0 ? paths : [process.cwd()]) {
		const abs = path.resolve(hint).toLowerCase()
		const hit = places.find((p) => abs === p.dir.toLowerCase() || abs.startsWith(p.dir.toLowerCase() + path.sep))
		if (hit) return hit
	}
	const live = ((await health())?.places ?? []).map((h) => places.find((p) => p.dir.toLowerCase() === h.dir.toLowerCase())).filter(Boolean)
	if (live.length === 1) return live[0]
	console.error(live.length === 0 ? "No Studio is connected, so pick a place with --place (see cinq places)" : `Several Studios are connected, pick one with --place: ${live.map((p) => p.label).join(", ")}`)
	process.exit(1)
}

async function refreshSourcemap(place) {
	try {
		const response = await fetch(`http://127.0.0.1:${PORT}/sourcemap`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ place: /^[1-9]d*$/.test(place.placeId) ? place.placeId : place.name }),
		})
		return await response.json()
	} catch {
		return { ok: false, error: "The Cinq server isn't running" }
	}
}

function usage(text) {
	console.error(`Usage: ${text}`)
	process.exit(1)
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

async function tool(name, args, toolArgs) {
	console.log(await toolText(name, args, toolArgs))
}

async function toolText(name, args, toolArgs, { raw = false } = {}) {
	let response
	try {
		response = await (
			await fetch(`http://127.0.0.1:${PORT}/tool`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tool: name, args: toolArgs, place: args.place, timeout: args.timeout }),
			})
		).json()
	} catch {
		console.error("The Cinq server isn't running. Start it with: cinq start")
		process.exit(1)
	}
	if (!response.ok) {
		console.error(response.error)
		process.exit(1)
	}
	if (raw) return response.text
	return response.text.replace(/→ (.+?\.luau)/g, (_, file) => `→ ${displayPath(path.normalize(file))}`)
}

const commands = {
	run: (args) => require("./index").startServer(args._[0], { awake: !args["no-awake"] }),

	start: async (args, argv) => {
		if (await health()) return console.log("Cinq is already running (cinq status)")
		const serverArgs = [__filename, "run", ...argv.filter((a) => a !== "--no-awake"), "--no-awake"]
		if (process.platform === "win32") startOutsideJob([process.execPath, ...serverArgs])
		else spawn(process.execPath, serverArgs, { detached: true, stdio: "ignore" }).unref()
		for (let i = 0; i < 50; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100))
			const running = await health()
			if (running) {
				console.log(`Cinq is running in the background (pid ${running.pid}). Stop it with: cinq stop`)
				if (!args["no-awake"]) await commands.awake({ _: [] })
				return
			}
		}
		console.error("Cinq didn't start, see cinq log")
		process.exit(1)
	},

	awake: async (args) => {
		const off = args._[0] === "off"
		const owner = off ? null : findOwner()
		let response
		try {
			response = await (
				await fetch(`http://127.0.0.1:${PORT}/awake`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(off ? { enabled: false } : { owner }),
				})
			).json()
		} catch {
			console.error("The Cinq server isn't running. Start it with: cinq start")
			process.exit(1)
		}
		console.log(response.awake ? `Keeping this computer awake until ${response.awake}` : "Not keeping this computer awake")
	},

	stop: async () => {
		const running = await health()
		if (!running) return console.log("Cinq isn't running")
		await fetch(`http://127.0.0.1:${PORT}/shutdown`, { method: "POST" })
		for (let i = 0; i < 50; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100))
			if (!(await health())) return console.log(`Stopped Cinq (pid ${running.pid})`)
		}
		console.error(`Cinq (pid ${running.pid}) didn't stop`)
		process.exit(1)
	},
	status: () => require("./status").main(),
	"install-plugin": async (args, argv) => {
		const installer = require("./install-plugin")
		installer.main(argv)
		if (args.mirror) await tool("exec", { place: args.mirror, timeout: 60 }, { code: installer.buildMirrorCode() })
	},

	changes: async (args, argv) => {
		const extra = args.root ? [] : ["--root", await placesDirOf(args)]
		await require("./changes").main([...argv, ...extra])
	},

	places: async (args) => {
		const root = await placesDirOf(args)
		const connected = new Set(((await health())?.places ?? []).map((p) => p.dir.toLowerCase()))
		const places = listPlaces(root)
		if (places.length === 0) return console.log(`No synced places in ${root}`)
		for (const place of places) {
			const { bytes } = await folderSize(place.dir)
			const live = connected.has(place.dir.toLowerCase()) ? "  connected" : ""
			console.log(`${place.label}  ${place.scripts} scripts  ${mb(bytes)}${live}`)
		}
	},

	size: async (args) => {
		const root = await placesDirOf(args)
		const all = listPlaces(root)
		const places = args._[0] ? [matchPlace(all, args._[0])] : all
		if (places.length === 0) {
			console.error("No synced places yet")
			process.exit(1)
		}
		let total = 0
		for (const place of places) {
			const { bytes, files } = await folderSize(place.dir)
			total += bytes
			console.log(`${place.label}: ${mb(bytes)} (${files} files)`)
		}
		if (places.length > 1) console.log(`Total: ${mb(total)}`)
	},

	conflicts: async (args) => {
		const root = await placesDirOf(args)
		const all = listPlaces(root)
		const places = args.place ? [matchPlace(all, args.place)] : all
		const resolving = args._[0] === "resolve"
		if (resolving && !args.all && !args._[1]) {
			console.error("Usage: cinq conflicts resolve <id> | --all")
			process.exit(1)
		}
		let count = 0
		for (const place of places) {
			const conflicts = listConflicts(place.dir).filter((c) => !resolving || args.all || c.id === args._[1])
			if (conflicts.length === 0) continue
			count += conflicts.length
			if (resolving) {
				for (const conflict of conflicts) resolveConflict(conflict)
				console.log(`${place.label}: cleared ${conflicts.map((c) => c.id).join(", ")}`)
				continue
			}
			console.log(`
${place.label}: ${conflicts.length} open conflict${conflicts.length === 1 ? "" : "s"}`)
			for (const conflict of conflicts) console.log(describeConflict(conflict, !args["no-diff"]))
		}
		if (count === 0) {
			if (resolving) {
				console.error(`No conflict matches "${args._[1]}"`)
				process.exit(1)
			}
			console.log("No open conflicts")
		}
	},

	wait: async (args) => {
		let response
		try {
			response = await (
				await fetch(`http://127.0.0.1:${PORT}/wait`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ place: args.place, timeout: args.timeout }),
				})
			).json()
		} catch {
			console.error("The Cinq server isn't running. Start it with: cinq start")
			process.exit(1)
		}
		if (response.error) {
			console.error(response.error)
			process.exit(1)
		}
		for (const place of response.places) {
			const state = place.settled ? `up to date (${place.ms} ms)` : `still ${place.pending} change${place.pending === 1 ? "" : "s"} pending after ${Math.round(place.ms / 1000)}s, see cinq log`
			console.log(`${place.place}: ${state}${place.flushed ? "" : " (Studio didn't confirm its own pending changes)"}`)
		}
		if (!response.ok) process.exit(1)
	},

	backup: async (args) => {
		const root = await placesDirOf(args)
		const all = listPlaces(root)
		const listing = args._[0] === "list"
		const wanted = listing ? args._[1] : args._[0]
		const places = wanted ? [matchPlace(all, wanted)] : all
		const backups = path.join(root, ".backups")
		if (listing) {
			let count = 0
			for (const place of places) {
				const dir = path.join(backups, place.name)
				const stamps = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
				for (const stamp of stamps) {
					const { bytes, files } = await folderSize(path.join(dir, stamp))
					console.log(`${place.label}  ${stamp}  ${files} files  ${mb(bytes)}`)
					count++
				}
			}
			if (count === 0) console.log("No backups yet")
			return
		}
		if (places.length === 0) return console.log("No synced places to back up")
		const now = new Date()
		const pad = (n) => String(n).padStart(2, "0")
		const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
		for (const place of places) {
			const dest = path.join(backups, place.name, stamp)
			fs.cpSync(place.dir, dest, { recursive: true, filter: (src) => path.basename(src) !== ".cinq" })
			const { bytes, files } = await folderSize(dest)
			console.log(`${place.label}: backed up ${files} files (${mb(bytes)}) to ${dest}`)
		}
	},

	log: async (args) => {
		const file = path.join(await placesDirOf(args), ".cinq", "server.log")
		const text = [file.replace(/\.log$/, ".old.log"), file].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")).join("")
		const place = args.place ? matchPlace(listPlaces(await placesDirOf(args)), args.place) : null
		const grep = args.grep?.toLowerCase()
		const lines = text.split("\n").filter((line) => {
			if (!line) return false
			const kind = line.slice(20, 26).trim()
			if (args.errors && kind !== "error") return false
			if (args.warnings && kind !== "warn" && kind !== "error") return false
			if (place && !line.includes(`[${place.name}]`)) return false
			return !grep || line.toLowerCase().includes(grep)
		})
		const limit = Math.max(1, Number(args.lines ?? 30))
		if (lines.length === 0) return console.log(fs.existsSync(file) ? "No matching log lines" : `No server log yet (${file})`)
		if (lines.length > limit) console.log(`(${lines.length - limit} earlier lines not shown, raise -n to see more)`)
		console.log(lines.slice(-limit).join("\n"))
	},

	console: (args) => tool("console", args, { lines: args.lines, errors: args.errors, warnings: args.warnings, grep: args.grep, full: args.full }),
	tree: (args) => tool("tree", args, { path: args._[0], depth: args.depth, limit: args.limit }),
	find: (args) => tool("find", args, { selector: args._[0], within: args.in, limit: args.limit }),
	inspect: (args) => tool("inspect", args, { path: args._[0], all: args.all }),
	config: (args) => {
		const config = require("./config")
		if (args._[0] === undefined) return config.show()
		if (args._[0] === "root") return config.setRoot(args, cliHelpers)
		usage("cinq config | cinq config root <folder> | cinq config root --reset")
	},
	link: (args) => require("./config").link(args, cliHelpers),
	unlink: (args) => require("./config").unlink(args, cliHelpers),
	sourcemap: async (args) => {
		const place = await pickPlace({ ...args, place: args.place ?? args._[0] })
		const result = await refreshSourcemap(place)
		if (!result.ok) {
			console.error(result.error)
			process.exit(1)
		}
		console.log(`Wrote ${displayPath(result.file)} (${result.instances} instances, ${result.scripts} scripts). It stays current as scripts change; open ${place.dir} in VS Code with the Luau extension to use it.`)
	},
	check: async (args) => {
		const place = await pickPlace(args, args._)
		if (!args["no-refresh"]) {
			const result = await refreshSourcemap(place)
			if (!result.ok) {
				if (!fs.existsSync(path.join(place.dir, SOURCEMAP_FILE))) {
					console.error(`${result.error}. The sourcemap is made from the connected Studio, so connect it once first.`)
					process.exit(1)
				}
				console.log(`(${result.error}, so using the last sourcemap)`)
			}
		}
		require("./check").run(place, args._, args)
	},
	drafts: (args) =>
		require("./drafts").main(args, {
			toolText,
			wait: () => commands.wait({ place: args.place }),
			editScript: (target, old, replacement) => toolText("edit", args, { path: target, edits: [{ old, new: replacement }] }),
		}),
	open: async (args) => {
		const target = args._[0]
		if (!target) usage("cinq open <file>[:line] | <instance path> [line]")
		const [, file, lineSuffix] = /^(.*?)(?::(\d+))?$/.exec(target)
		const line = Number(args._[1] ?? lineSuffix ?? 1)
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return tool("open", args, { path: file, line })
		const abs = path.resolve(file)
		const place = listPlaces(await placesDirOf(args)).find((p) => abs.toLowerCase().startsWith(p.dir.toLowerCase() + path.sep))
		if (!place) usage(`${file} isn't inside a synced place's folder (see cinq places)`)
		const rel = path.relative(place.dir, abs).split(path.sep).join("/").toLowerCase()
		const id = Object.entries(readState(place.dir)?.scripts ?? {}).find(([, st]) => st.path.toLowerCase() === rel)?.[0]
		if (!id) usage(`${file} isn't synced to a script yet (cinq wait, then try again)`)
		const placeArg = args.place ?? (/^[1-9]\d*$/.test(place.placeId) ? place.placeId : place.name)
		return tool("open", { ...args, place: placeArg }, { id, line })
	},
	selection: (args) => tool("selection", args, {}),
	grep: (args) => {
		if (!args._[0]) usage("cinq grep <text> [--in <path>] [-i] [--lua] [--limit 100]")
		return tool("grep", args, { pattern: args._[0], within: args.in, ignoreCase: args["ignore-case"], lua: args.lua, limit: args.limit })
	},
	read: (args) => {
		if (!args._[0]) usage("cinq read <path> [--from 1] [--to 200]")
		return tool("read", args, { path: args._[0], from: args.from, to: args.to })
	},
	edit: (args) => {
		const [target, file] = args._
		let edits
		if (args.old !== undefined) edits = [{ old: args.old, new: args.new ?? "", all: args.all }]
		else if (file) {
			try {
				edits = JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8"))
			} catch (err) {
				console.error(`Couldn't read edits from ${file === "-" ? "stdin" : file}: ${err.message}`)
				process.exit(1)
			}
		}
		if (!target || !edits) usage('cinq edit <path> --old <text> --new <text> [--all] | cinq edit <path> <edits.json | -> with [{"old": "...", "new": "...", "all": false}]')
		return tool("edit", args, { path: target, edits: Array.isArray(edits) ? edits : [edits] })
	},
	exec: (args) => {
		const code = args.code ?? (args._[0] ? fs.readFileSync(args._[0], "utf8") : null)
		if (!code) {
			console.error("Usage: cinq exec <file.luau> | -e <code>")
			process.exit(1)
		}
		return tool("exec", args, { code })
	},
}

const cliHelpers = { health, listPlaces, matchPlace, commands }

// Piping into something like `head` closes stdout early; that's not an error.
process.stdout.on("error", (err) => {
	if (err.code === "EPIPE") process.exit(0)
	throw err
})

async function main() {
	const argv = process.argv.slice(2)
	const name = argv[0] ?? "run"
	if (name === "help" || name === "--help" || name === "-h") return console.log(HELP)
	const command = commands[name]
	if (!command) {
		console.error(`Unknown command "${name}"\n\n${HELP}`)
		process.exit(1)
	}
	const rest = argv.slice(1)
	await command(parse(rest), rest)
}

main()
