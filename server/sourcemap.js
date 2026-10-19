"use strict"

const fs = require("fs")
const path = require("path")
const { encodeName } = require("./paths")

const SOURCEMAP_FILE = "sourcemap.json"
const VSCODE_SETTINGS = {
	"luau-lsp.platform.type": "roblox",
	"luau-lsp.sourcemap.enabled": true,
	"luau-lsp.sourcemap.autogenerate": false,
	"luau-lsp.sourcemap.sourcemapFile": SOURCEMAP_FILE,
}

const UNSYNCED_DIR = ".cinq/unsynced"

// The plugin sends [name, className, id, children, source?] nodes. Synced scripts point at their file, and scripts
// Cinq doesn't sync (packages, ignored ones) at a read-only copy, so requiring them still resolves.
function buildSourcemap(nodes, fileOf) {
	let instances = 0
	let scripts = 0
	const unsynced = []
	const convert = ([name, className, id, children, source]) => {
		instances++
		const node = { name, className }
		const file = id ? fileOf(id) : null
		if (file) {
			node.filePaths = [file]
			scripts++
		} else if (typeof source === "string") {
			const copy = `${UNSYNCED_DIR}/${unsynced.length + 1}-${encodeName(name)}.luau`
			unsynced.push({ file: copy, source })
			node.filePaths = [copy]
		}
		if (children?.length) node.children = children.map(convert)
		return node
	}
	const map = { name: "Game", className: "DataModel", children: nodes.map(convert) }
	return { map, instances, scripts, unsynced }
}

// So opening the place folder in VS Code with the Luau extension uses this sourcemap instead of trying Rojo.
function writeEditorSettings(dir) {
	const file = path.join(dir, ".vscode", "settings.json")
	if (fs.existsSync(file)) return false
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(VSCODE_SETTINGS, null, "\t") + "\n")
	return true
}

module.exports = { SOURCEMAP_FILE, UNSYNCED_DIR, buildSourcemap, writeEditorSettings }
