"use strict"

const test = require("node:test")
const assert = require("node:assert")
const { encodeName, decodeName, scriptPath, parsePath } = require("../paths")

test("names round-trip through encoding", () => {
	const names = ["Foo", "a/b", "what?", "C:\\x", "100%", "init", "Init", "CON", "con.txt", "Foo.server", "Foo.client", ".hidden", "trail.", "trail ", "", "~tilde", "Foo.luau", "日本", "a|b*c"]
	for (const name of names) {
		const encoded = encodeName(name)
		assert.doesNotMatch(encoded, /[<>:"/\\|?*~]/, `${name} -> ${encoded}`)
		assert.strictEqual(decodeName(encoded), name)
	}
	assert.strictEqual(encodeName("a/b"), "a%2Fb")
})

test("script paths round-trip", () => {
	const entries = [
		{ segments: [{ name: "ServerScriptService" }, { name: "Main" }], kind: "server", isDir: false },
		{ segments: [{ name: "ReplicatedStorage" }, { name: "Shared" }, { name: "Util" }], kind: "module", isDir: true },
		{ segments: [{ name: "StarterPlayer" }, { name: "StarterPlayerScripts" }, { name: "Input" }], kind: "local", isDir: false },
		{ segments: [{ name: "ReplicatedStorage" }, { name: "Dup", id: "abc123" }, { name: "init" }], kind: "client", isDir: false },
		{ segments: [{ name: "ReplicatedStorage" }, { name: "Weird.server" }], kind: "module", isDir: false },
	]
	for (const entry of entries) {
		const rel = scriptPath(entry)
		assert.deepStrictEqual(parsePath(rel), entry, rel)
	}
	assert.strictEqual(scriptPath(entries[1]), "ReplicatedStorage/Shared/Util/init.luau")
	assert.strictEqual(scriptPath(entries[3]), "ReplicatedStorage/Dup~abc123/%69nit.client.luau")
})

test("unmappable paths are rejected", () => {
	assert.strictEqual(parsePath("Workspace/Foo.luau"), null)
	assert.strictEqual(parsePath("ServerScriptService/init.server.luau"), null)
	assert.strictEqual(parsePath("ServerScriptService/notes.txt"), null)
	assert.strictEqual(parsePath("ServerScriptService/.git/x.luau"), null)
})
