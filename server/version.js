"use strict"

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const VERSION = require("../package.json").version
const PLUGIN_SOURCE = path.join(__dirname, "..", "plugin")

// A hash of plugin/, baked into each plugin build, so a plugin built from other source is caught even when the version
// number didn't change (an update pulled without reinstalling the plugin). LF-normalized, since git may check out CRLF.
function hashPluginSource(dir = PLUGIN_SOURCE) {
	const hash = crypto.createHash("sha256")
	const files = fs
		.readdirSync(dir)
		.filter((file) => file.toLowerCase().endsWith(".luau"))
		.sort()
	for (const file of files) {
		hash.update(`${file}\0`)
		hash.update(fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n"))
		hash.update("\0")
	}
	return hash.digest("hex").slice(0, 12)
}

// Not cached: editing plugin/ and reinstalling the plugin shouldn't need a server restart to match again.
const pluginBuild = () => hashPluginSource()

function compareVersions(a, b) {
	const pa = String(a).split(".").map(Number)
	const pb = String(b).split(".").map(Number)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0)
		if (diff !== 0) return Math.sign(diff)
	}
	return 0
}

// What's wrong with a connecting plugin compared with this server, or null when they match.
function pluginMismatch(plugin, server = { version: VERSION, build: pluginBuild() }) {
	if (!plugin?.version) return `This Cinq plugin is older than the server (${server.version}). Update the plugin: cinq install-plugin`
	const order = compareVersions(plugin.version, server.version)
	if (order < 0) return `This Cinq plugin (${plugin.version}) is older than the server (${server.version}). Update the plugin: cinq install-plugin`
	if (order > 0) return `The Cinq server (${server.version}) is older than this plugin (${plugin.version}). Update Cinq: cinq update`
	if (plugin.build && plugin.build !== server.build) return "This Cinq plugin was built from different source than the server's. Update the plugin: cinq install-plugin"
	return null
}

module.exports = { VERSION, hashPluginSource, pluginBuild, compareVersions, pluginMismatch }
