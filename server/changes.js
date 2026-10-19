"use strict"

const fs = require("fs")
const path = require("path")
const { placesDir, listPlaceDirs } = require("./places")

const PORT = Number(process.env.CINQ_PORT ?? 34877)
const ORIGINS = { studio: "Studio", "studio-offline": "Studio, while Cinq was off", disk: "Disk" }
const USAGE = "Usage: cinq changes [--since 24h|3d|<ISO date>] [--place <name>] [--root <places folder>] [--origin studio|disk] [--no-diff]"

function parseArgs(argv) {
	const args = { since: "24h", place: null, root: null, origin: null, diff: true }
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]
		if (flag === "--no-diff") args.diff = false
		else if (["--since", "--place", "--root", "--origin"].includes(flag)) args[flag.slice(2)] = argv[++i]
		else {
			console.log(USAGE)
			process.exit(1)
		}
	}
	return args
}

function placeNameOf(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, ".cinq", "state.json"), "utf8")).placeName ?? ""
	} catch {
		return ""
	}
}

function sinceDate(value) {
	const relative = /^(\d+)([mhd])$/.exec(value)
	if (!relative) return new Date(value)
	const unit = { m: 60e3, h: 3600e3, d: 86400e3 }[relative[2]]
	return new Date(Date.now() - Number(relative[1]) * unit)
}

function readJournal(placeDir) {
	const entries = []
	for (const file of ["journal.old.jsonl", "journal.jsonl"]) {
		let text
		try {
			text = fs.readFileSync(path.join(placeDir, ".cinq", file), "utf8")
		} catch {
			continue
		}
		for (const line of text.split("\n")) {
			if (!line) continue
			try {
				entries.push(JSON.parse(line))
			} catch {}
		}
	}
	return entries
}

function readUsers(placeDir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(placeDir, ".cinq", "state.json"), "utf8")).users ?? {}
	} catch {
		return {}
	}
}

function who(entry, users) {
	if (!entry.by) return ""
	if (entry.by === "unknown") return " (by someone without Cinq)"
	return ` (by ${users[entry.by] ?? `user ${entry.by}`})`
}

function describe(entry) {
	if (entry.kind === "edit") return `edited ${entry.path} (+${entry.added} -${entry.removed})`
	if (entry.kind === "create") return `created ${entry.path} (${entry.lines} lines)`
	if (entry.kind === "delete") return `deleted ${entry.path}`
	if (entry.kind === "move") return `moved ${entry.from} → ${entry.path}`
	if (entry.kind === "conflict") return `conflict in ${entry.path}: ${entry.note}`
	return `${entry.kind} ${entry.path}`
}

async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv)
	const since = sinceDate(args.since)
	if (Number.isNaN(since.getTime())) {
		console.log(USAGE)
		process.exit(1)
	}
	try {
		await fetch(`http://127.0.0.1:${PORT}/journal/flush`, { method: "POST" })
	} catch {}

	const base = placesDir(args.root)
	let places = listPlaceDirs(base)
	if (places.length === 0) return console.log(`No synced places in ${base}`)
	if (args.place) {
		const wanted = args.place.toLowerCase()
		const names = (p) => [p.name, p.linked || "", placeNameOf(p.dir)].map((v) => v.toLowerCase())
		const exact = places.filter((p) => names(p).includes(wanted))
		places = exact.length > 0 ? exact : places.filter((p) => names(p).some((v) => v.includes(wanted)))
	}

	let total = 0
	for (const { dir, name } of places) {
		const entries = readJournal(dir)
			.filter((e) => new Date(e.time) >= since && (!args.origin || e.origin.startsWith(args.origin)))
			.sort((a, b) => a.time.localeCompare(b.time))
		if (entries.length === 0) continue
		total += entries.length
		const users = readUsers(dir)
		console.log(`\n${name}: ${entries.length} change${entries.length === 1 ? "" : "s"} since ${since.toLocaleString()}`)
		for (const entry of entries) {
			console.log(`[${new Date(entry.time).toLocaleString()}] ${ORIGINS[entry.origin] ?? entry.origin}${who(entry, users)}: ${describe(entry)}`)
			if (args.diff && entry.diff) console.log(entry.diff.replace(/^/gm, "    "))
		}
	}
	if (total === 0) console.log(`No changes since ${since.toLocaleString()}`)
}

if (require.main === module) main()

module.exports = { main }
