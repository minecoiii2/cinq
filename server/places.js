"use strict"

const fs = require("fs")
const path = require("path")
const { encodeName } = require("./paths")
const log = require("./log")

const SYNC_FOLDER = "Cinq"
// Every place syncs into one central Cinq folder next to the app, wherever the CLI runs from, unless configured.
const DEFAULT_ROOT = path.join(__dirname, "..")
const DEFAULT_PLACES_DIR = path.join(DEFAULT_ROOT, SYNC_FOLDER)
// Outside the repo, so updating Cinq never touches it.
const CONFIG_FILE = process.env.CINQ_CONFIG ?? path.join(require("os").homedir(), ".cinq", "config.json")

function readConfig() {
	try {
		const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
		return { root: typeof config.root === "string" ? config.root : null, links: config.links && typeof config.links === "object" ? config.links : {} }
	} catch {
		return { root: null, links: {} }
	}
}

function writeConfig(config) {
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
	const saved = { ...(config.root ? { root: config.root } : {}), links: config.links ?? {} }
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, "\t") + "\n")
}

// The folder places sync into: an explicit override (cinq run <folder>), then `cinq config root`, then the default.
function placesDir(override) {
	if (override) return path.resolve(override)
	const { root } = readConfig()
	return root ? path.resolve(root) : DEFAULT_PLACES_DIR
}

// How a place is named in links: its PlaceId, or 0:<file name> for unpublished places.
function placeKey(placeId, placeName) {
	return String(placeId) === "0" ? `0:${String(placeName ?? "").trim() || "Untitled"}` : String(placeId)
}

// Every place folder: the ones in the places folder plus each linked folder that exists.
function listPlaceDirs(base, config = readConfig()) {
	const dirs = listFolders(base).map((name) => ({ dir: path.join(base, name), name, linked: false }))
	for (const [key, dir] of Object.entries(config.links)) {
		const resolved = path.resolve(dir)
		if (fs.existsSync(resolved) && !dirs.some((d) => d.dir.toLowerCase() === resolved.toLowerCase())) dirs.push({ dir: resolved, name: path.basename(resolved), linked: key })
	}
	return dirs
}

// state.json holds every script's source (megabytes on big places) but starts with the PlaceId, so only its head is read.
function ownerOf(dir, name) {
	try {
		const fd = fs.openSync(path.join(dir, ".cinq", "state.json"), "r")
		try {
			const head = Buffer.alloc(512)
			const length = fs.readSync(fd, head, 0, head.length, 0)
			const match = /"placeId":"?(\d+)"?/.exec(head.toString("utf8", 0, length))
			if (match) return match[1]
		} finally {
			fs.closeSync(fd)
		}
	} catch {}
	// A PlaceId-named folder whose state is missing still belongs to that place.
	return /^\d+$/.test(name) ? name : ""
}

function listFolders(base) {
	try {
		return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)
	} catch {
		return []
	}
}

// Published places are named by PlaceId. Unpublished ones all have PlaceId 0, so they're named and told apart by file name.
function resolvePlaceDir(base, placeId, placeName, { rename = false, links = {} } = {}) {
	const linked = links[placeKey(placeId, placeName)]
	if (linked) return path.resolve(linked)
	const wanted = placeId === "0" ? encodeName(placeName.trim() || "Untitled") : placeId
	const candidates = [wanted]
	const owner = (name) => (fs.existsSync(path.join(base, name)) ? ownerOf(path.join(base, name), name) : undefined)

	const existing = placeId === "0" ? undefined : listFolders(base).find((name) => ownerOf(path.join(base, name), name) === placeId)
	if (existing !== undefined) {
		if (candidates.includes(existing) || !rename) return path.join(base, existing)
		const target = candidates.find((name) => owner(name) === undefined)
		if (!target) return path.join(base, existing)
		try {
			fs.renameSync(path.join(base, existing), path.join(base, target))
			log.info(`Renamed ${SYNC_FOLDER}/${existing} → ${SYNC_FOLDER}/${target}`)
			return path.join(base, target)
		} catch (err) {
			log.warn(`Couldn't rename ${SYNC_FOLDER}/${existing} to ${target} (${err.code}), keeping the old name`)
			return path.join(base, existing)
		}
	}
	const free = candidates.find((name) => {
		const current = owner(name)
		return current === undefined || current === placeId
	})
	return path.join(base, free ?? `${wanted} (${placeId}-${Date.now()})`)
}

async function folderSize(dir) {
	let bytes = 0
	let files = 0
	const visit = async (current) => {
		let entries
		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) await visit(full)
			else if (entry.isFile()) {
				bytes += (await fs.promises.stat(full)).size
				files++
			}
		}
	}
	await visit(dir)
	return { bytes, files }
}

module.exports = {
	SYNC_FOLDER,
	DEFAULT_ROOT,
	DEFAULT_PLACES_DIR,
	CONFIG_FILE,
	readConfig,
	writeConfig,
	placesDir,
	placeKey,
	listPlaceDirs,
	resolvePlaceDir,
	folderSize,
}
