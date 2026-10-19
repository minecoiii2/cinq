"use strict"

const fs = require("fs")
const path = require("path")
const { unifiedDiff } = require("./journal")

const KIND_LABELS = {
	conflict: "both sides edited the same lines, Studio's version was kept",
	replaced: "an untracked file was overwritten by a Studio script",
	removed: "the script was deleted in Studio while its file had unsynced edits",
	backup: "backup from an older Cinq version",
}

const read = (file) => {
	try {
		return fs.readFileSync(file, "utf8")
	} catch {
		return undefined
	}
}

function filesUnder(dir, prefix = "") {
	const out = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), rel))
		else out.push(rel)
	}
	return out
}

function listConflicts(placeDir) {
	const base = path.join(placeDir, ".cinq", "conflicts")
	let ids
	try {
		ids = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
	} catch {
		return []
	}
	return ids
		.map((id) => {
			const dir = path.join(base, id)
			const info = read(path.join(dir, "info.json"))
			if (info) return { ...JSON.parse(info), dir }
			return { id, dir, kind: "backup", time: "", path: filesUnder(dir).join(", ") }
		})
		.sort((a, b) => a.id.localeCompare(b.id))
}

function describeConflict(conflict, withDiff) {
	const lines = [`${conflict.id}  ${conflict.path}`, `  ${KIND_LABELS[conflict.kind] ?? conflict.kind}`]
	if (conflict.time) lines[0] += `  (${new Date(conflict.time).toLocaleString()})`
	const base = read(path.join(conflict.dir, "base.luau"))
	const studio = read(path.join(conflict.dir, "studio.luau"))
	const disk = read(path.join(conflict.dir, "disk.luau"))
	if (withDiff && base !== undefined) {
		for (const [label, text] of [["Studio changed", studio], ["Disk changed (lost from the file)", disk]]) {
			if (text === undefined) continue
			const { diff } = unifiedDiff(base, text)
			lines.push(`  ${label}:`, diff ? diff.replace(/^/gm, "    ") : "    (nothing)")
		}
	}
	lines.push(`  files: ${conflict.dir}`)
	return lines.join("\n")
}

function resolveConflict(conflict) {
	fs.rmSync(conflict.dir, { recursive: true, force: true })
}

module.exports = { listConflicts, describeConflict, resolveConflict }
