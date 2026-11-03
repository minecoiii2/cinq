"use strict"

const fs = require("fs")
const path = require("path")
const { SERVICES, encodeName, parsePath } = require("./paths")
const { SOURCEMAP_FILE } = require("./sourcemap")

// Rojo can't make a LocalScript in its modern mode (emitLegacyScripts: false), so places with one use legacy mode,
// where .client is a LocalScript and .server a legacy Script, and other run contexts come from meta files.
const LEGACY_MODE = {
	module: { suffix: "" },
	local: { suffix: ".client" },
	legacy: { suffix: ".server" },
	server: { suffix: ".server", runContext: "Server" },
	client: { suffix: ".server", runContext: "Client" },
	plugin: { suffix: ".plugin" },
}
const MODERN_MODE = {
	module: { suffix: "" },
	legacy: { suffix: ".server", runContext: "Legacy" },
	server: { suffix: ".server" },
	client: { suffix: ".client" },
	plugin: { suffix: ".plugin" },
}

// Container classes and which scripts have non-script children, from the sourcemap Cinq writes for luau-lsp.
function readSourcemap(map) {
	const containers = new Map()
	const scriptsWithChildren = new Set()
	const visit = (node, rel) => {
		const file = node.filePaths?.[0]
		if (file && (node.children?.length ?? 0) > 0) scriptsWithChildren.add(file)
		if (!file && rel.includes("/") && node.className !== "Folder") containers.set(rel, node.className)
		for (const child of node.children ?? []) visit(child, `${rel}/${encodeName(child.name)}`)
	}
	for (const service of map?.children ?? []) {
		if (SERVICES.includes(service.name)) visit(service, service.name)
	}
	return { containers, scriptsWithChildren }
}

// files: [{ rel, text }] relative to the place's folder. Returns the Rojo project's files, relative to its root.
function buildRojoExport(files, map, projectName) {
	const parsed = files.map((file) => ({ ...file, parsed: parsePath(file.rel) })).filter((file) => file.parsed)
	const legacyMode = parsed.some((file) => file.parsed.kind === "local")
	const mode = legacyMode ? LEGACY_MODE : MODERN_MODE
	const { containers, scriptsWithChildren } = readSourcemap(map)
	const out = new Map()
	const metas = new Map()
	const meta = (rel) => metas.get(rel) ?? metas.set(rel, {}).get(rel)
	const warnings = new Set()

	for (const { rel, text, parsed: info } of parsed) {
		const parts = rel.split("/")
		const dirs = parts.slice(0, -1)
		const { suffix, runContext } = mode[info.kind]
		for (const segment of parts.slice(1, info.isDir ? -1 : undefined)) {
			if (/%|~/.test(segment)) warnings.add(`${rel}: "${segment}" can't be named like that in Rojo, rename it in Studio`)
		}
		const stem = parts[parts.length - 1].replace(/(\.(server|client|local|legacy|plugin))?\.luau$/i, "")
		out.set(`src/${[...dirs, `${stem}${suffix}.luau`].join("/")}`, text)
		const metaFile = `src/${[...dirs, `${stem}.meta.json`].join("/")}`
		if (runContext) meta(metaFile).properties = { RunContext: runContext }
		// Without this, rojo serve deletes the script's non-script children in Studio.
		if (!info.isDir && scriptsWithChildren.has(rel)) meta(metaFile).ignoreUnknownInstances = true

		for (let depth = 2; depth <= dirs.length; depth++) {
			const dir = dirs.slice(0, depth).join("/")
			const dirMeta = meta(`src/${dir}/init.meta.json`)
			dirMeta.ignoreUnknownInstances = true
			if (containers.has(dir)) dirMeta.className = containers.get(dir)
		}
	}
	// A folder holding an init script is that script, and Rojo refuses a className for it.
	for (const rel of out.keys()) {
		const initMatch = /^(.*)\/init(\.\w+)?\.luau$/.exec(rel)
		if (initMatch) delete metas.get(`${initMatch[1]}/init.meta.json`)?.className
	}
	const keptContainers = [...metas.values()].filter((value) => value.className).length
	for (const [rel, value] of metas) out.set(rel, JSON.stringify(value, null, "\t") + "\n")

	const services = SERVICES.filter((service) => parsed.some((file) => file.rel.startsWith(`${service}/`)))
	const tree = { $className: "DataModel" }
	for (const service of services) tree[service] = { $path: `src/${service}`, $ignoreUnknownInstances: true }
	out.set("default.project.json", JSON.stringify({ name: projectName, emitLegacyScripts: legacyMode, tree }, null, "\t") + "\n")

	return { files: out, legacyMode, scripts: parsed.length, metaFiles: metas.size, containers: keptContainers, warnings: [...warnings] }
}

function listPlaceFiles(placeDir) {
	const files = []
	const visit = (rel) => {
		let entries = []
		try {
			entries = fs.readdirSync(path.join(placeDir, rel), { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue
			const child = `${rel}/${entry.name}`
			if (entry.isDirectory()) visit(child)
			else if (entry.name.toLowerCase().endsWith(".luau")) files.push({ rel: child, text: fs.readFileSync(path.join(placeDir, child), "utf8") })
		}
	}
	for (const service of SERVICES) visit(service)
	return files
}

function run(place, target, { sourcemapNote } = {}) {
	const out = path.resolve(target)
	if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
		console.error(`${out} isn't empty, pick a new or empty folder`)
		process.exit(1)
	}
	let map = null
	try {
		map = JSON.parse(fs.readFileSync(path.join(place.dir, SOURCEMAP_FILE), "utf8"))
	} catch {}
	const name = place.placeName.replace(/[^\w\- ]+/g, "").trim() || place.name
	const result = buildRojoExport(listPlaceFiles(place.dir), map, name)
	for (const [rel, text] of result.files) {
		fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true })
		fs.writeFileSync(path.join(out, rel), text)
	}
	console.log(`Exported ${result.scripts} scripts from ${place.label} as a Rojo project in ${out}`)
	console.log(`  ${result.legacyMode ? "Legacy" : "Modern"} script mode (emitLegacyScripts: ${result.legacyMode}), ${result.metaFiles} .meta.json files, ${result.containers} non-Folder containers kept`)
	if (sourcemapNote) console.log(`  ${sourcemapNote}`)
	if (!map) console.log("  No sourcemap, so non-Folder containers (ScreenGuis, Tools…) became Folders; connect Studio and run it again to keep them")
	console.log("  Only scripts are exported; every folder ignores instances Rojo doesn't know about, so rojo serve leaves UI, models and remotes in Studio alone")
	if (result.warnings.length > 0) {
		console.log(`  ${result.warnings.length} name${result.warnings.length === 1 ? "" : "s"} Rojo can't represent:`)
		for (const warning of result.warnings.slice(0, 20)) console.log(`    ${warning}`)
		if (result.warnings.length > 20) console.log(`    … ${result.warnings.length - 20} more`)
	}
}

module.exports = { buildRojoExport, readSourcemap, run }
