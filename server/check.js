"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")
const { SERVICES } = require("./paths")
const { SOURCEMAP_FILE } = require("./sourcemap")

const EXE = process.platform === "win32" ? "luau-lsp.exe" : "luau-lsp"
const EDITORS = ["Code", "Code - Insiders", "Cursor", "VSCodium", "Windsurf"]
// luau-lsp prints "file [module name](line,column): Kind: message", with extra lines for long messages.
const BASELINE_FILE = path.join(".cinq", "check-baseline.json")
const PROBLEM =/^(.+?)(?: \[[^\]]*\])?\((\d+),(\d+)\): (\w+): (.*)$/

function findLuauLsp() {
	const dirs = [
		...(process.env.PATH ?? "").split(path.delimiter),
		...[".rokit", ".aftman", ".foreman"].map((tool) => path.join(os.homedir(), tool, "bin")),
	]
	for (const dir of dirs) {
		if (dir && fs.existsSync(path.join(dir, EXE))) return path.join(dir, EXE)
	}
	return null
}

const appData = () =>
	process.platform === "win32"
		? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
		: process.platform === "darwin"
			? path.join(os.homedir(), "Library", "Application Support")
			: path.join(os.homedir(), ".config")

// The Luau VS Code extension keeps Roblox's type definitions current, so reuse its newest copy.
function findDefinitions() {
	if (process.env.CINQ_LUAU_DEFS) return process.env.CINQ_LUAU_DEFS
	const found = []
	for (const editor of EDITORS) {
		const dir = path.join(appData(), editor, "User", "globalStorage", "johnnymorganz.luau-lsp")
		let names = []
		try {
			names = fs.readdirSync(dir)
		} catch {
			continue
		}
		for (const name of names.filter((n) => /^globalTypes.*\.d\.luau$/.test(n))) {
			const file = path.join(dir, name)
			found.push({ file, mtime: fs.statSync(file).mtimeMs })
		}
	}
	return found.sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null
}

function parseProblems(output, placeDir) {
	const problems = []
	for (const line of output.split(/\r?\n/)) {
		if (line === "" || /^\[(INFO|WARN)\]/.test(line)) continue
		const match = PROBLEM.exec(line)
		if (match) {
			const [, file, row, column, kind, message] = match
			problems.push({ file: path.resolve(placeDir, file), row: Number(row), column: Number(column), kind, message, more: [] })
		} else if (problems.length > 0) {
			problems.at(-1).more.push(line.trim())
		}
	}
	return problems
}

// Relative to the current folder when the file is inside it, otherwise absolute (Cinq is used from any project).
function displayPath(file) {
	const rel = path.relative(process.cwd(), file)
	return (rel.startsWith("..") || path.isAbsolute(rel) ? file : rel).split(path.sep).join("/")
}
const posix = (rel) => rel.split(path.sep).join("/")

// Lines shift with every edit, so problems are matched by file, kind and message, counting repeats.
const problemKey = (p, placeDir) => `${posix(path.relative(placeDir, p.file))}\n${p.kind}\n${p.message}`

function countKeys(problems, placeDir) {
	const counts = {}
	for (const p of problems) {
		const key = problemKey(p, placeDir)
		counts[key] = (counts[key] ?? 0) + 1
	}
	return counts
}

// Problems whose count went up since the baseline. The baseline only ever shrinks for the checked files,
// so a fixed problem that comes back is reported as new.
function compareToBaseline(problems, baseline, placeDir, inScope) {
	const counts = countKeys(problems, placeDir)
	const fresh = problems.filter((p) => counts[problemKey(p, placeDir)] > (baseline[problemKey(p, placeDir)] ?? 0))
	const tightened = {}
	for (const [key, count] of Object.entries(baseline)) {
		const kept = inScope(key.slice(0, key.indexOf("\n"))) ? Math.min(count, counts[key] ?? 0) : count
		if (kept > 0) tightened[key] = kept
	}
	return { fresh, tightened }
}

function run(place, targets, args) {
	const lsp = findLuauLsp()
	if (!lsp) {
		console.error("luau-lsp isn't installed. Install it with rokit (rokit add JohnnyMorganz/luau-lsp) or from https://github.com/JohnnyMorganz/luau-lsp/releases")
		process.exit(1)
	}
	const defs = args.defs ?? findDefinitions()
	if (!defs) {
		console.error("Roblox type definitions not found. Install the Luau VS Code extension (JohnnyMorganz.luau-lsp) and open any .luau file once, or pass --defs <globalTypes.d.luau> (or set CINQ_LUAU_DEFS)")
		process.exit(1)
	}
	const wholePlace = targets.length === 0
	const relTargets = wholePlace ? SERVICES.filter((s) => fs.existsSync(path.join(place.dir, s))) : targets.map((t) => posix(path.relative(place.dir, path.resolve(t))) || ".")
	// The new type solver is what Studio uses; the old one reports thousands of errors Studio doesn't.
	const result = spawnSync(lsp, ["analyze", "--platform=roblox", "--flag:LuauSolverV2=true", `--sourcemap=${SOURCEMAP_FILE}`, `--defs=${defs}`, ...relTargets], {
		cwd: place.dir,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		windowsHide: true,
	})
	if (result.error) {
		console.error(`Couldn't run luau-lsp: ${result.error.message}`)
		process.exit(1)
	}
	const all = parseProblems(`${result.stdout}\n${result.stderr}`, place.dir)
	const baselineFile = path.join(place.dir, BASELINE_FILE)
	let baseline = null
	try {
		baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"))
	} catch {}

	if (wholePlace && (args.baseline || (!baseline && !args.all))) {
		fs.writeFileSync(baselineFile, JSON.stringify(countKeys(all, place.dir)))
		const files = new Set(all.map((p) => p.file)).size
		return console.log(`Recorded ${all.length} existing problems in ${files} files as this place's baseline. From now on cinq check only reports problems that are new (--all shows every one, --baseline records them again).`)
	}

	let problems = all
	if (baseline && !args.all) {
		const inScope = (rel) => wholePlace || relTargets.some((t) => t === "." || rel === t || rel.startsWith(`${t}/`))
		const { fresh, tightened } = compareToBaseline(all, baseline, place.dir, inScope)
		fs.writeFileSync(baselineFile, JSON.stringify(tightened))
		problems = fresh
		if (problems.length === 0) {
			const known = all.length > 0 ? ` (${all.length} known in the baseline, --all shows them)` : ""
			return console.log(`No new problems in ${relTargets.join(", ")}${known}`)
		}
	} else if (problems.length === 0) {
		return console.log(`No problems in ${relTargets.join(", ")}`)
	}

	const kinds = {}
	for (const p of problems) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1
	const files = new Set(problems.map((p) => p.file))
	const limit = Math.max(1, Number(args.lines ?? 50))
	console.log(`${problems.length}${problems === all ? "" : " new"} problem${problems.length === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"} (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")})`)
	for (const p of problems.slice(0, limit)) {
		console.log(`${displayPath(p.file)}:${p.row}:${p.column} ${p.kind}: ${p.message}`)
		const more = args.full ? p.more : p.more.slice(0, 2)
		for (const line of more) console.log(`    ${line}`)
	}
	if (problems.length > limit) console.log(`… ${problems.length - limit} more, narrow the paths or raise -n`)
	process.exitCode = 1
}

module.exports = { run, displayPath, parseProblems, compareToBaseline, countKeys, findLuauLsp, findDefinitions }
