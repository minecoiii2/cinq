"use strict"

const fs = require("fs")
const path = require("path")
const { encodeName } = require("./paths")
const log = require("./log")

const SYNC_FOLDER = "Cinq"
// Every place syncs into one central Cinq folder next to the app, wherever the CLI runs from.
const DEFAULT_ROOT = path.join(__dirname, "..")

function ownerOf(dir, name) {
	try {
		const state = JSON.parse(fs.readFileSync(path.join(dir, ".cinq", "state.json"), "utf8"))
		if (state.placeId !== undefined) return String(state.placeId)
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
function resolvePlaceDir(root, placeId, placeName, { rename = false } = {}) {
	const base = path.join(root, SYNC_FOLDER)
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

module.exports = { SYNC_FOLDER, DEFAULT_ROOT, resolvePlaceDir, folderSize }
