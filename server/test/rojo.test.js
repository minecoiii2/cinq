"use strict"

const test = require("node:test")
const assert = require("node:assert")
const { buildRojoExport } = require("../rojo")

const file = (rel) => ({ rel, text: `-- ${rel}\n` })
const json = (result, rel) => JSON.parse(result.files.get(rel))

test("a place with a LocalScript uses legacy mode, with meta files for the other run contexts", () => {
	const result = buildRojoExport(
		[
			file("ReplicatedStorage/Mod.luau"),
			file("StarterPlayer/StarterPlayerScripts/Input.local.luau"),
			file("ServerScriptService/Old.legacy.luau"),
			file("ServerScriptService/Main.server.luau"),
			file("ReplicatedStorage/Ui.client.luau"),
			file("ServerScriptService/Tool.plugin.luau"),
		],
		null,
		"Game"
	)
	assert.strictEqual(result.legacyMode, true)
	const names = [...result.files.keys()].filter((rel) => rel.endsWith(".luau")).sort()
	assert.deepStrictEqual(names, [
		"src/ReplicatedStorage/Mod.luau",
		"src/ReplicatedStorage/Ui.server.luau",
		"src/ServerScriptService/Main.server.luau",
		"src/ServerScriptService/Old.server.luau",
		"src/ServerScriptService/Tool.plugin.luau",
		"src/StarterPlayer/StarterPlayerScripts/Input.client.luau",
	])
	assert.deepStrictEqual(json(result, "src/ServerScriptService/Main.meta.json").properties, { RunContext: "Server" })
	assert.deepStrictEqual(json(result, "src/ReplicatedStorage/Ui.meta.json").properties, { RunContext: "Client" })
	assert.strictEqual(result.files.has("src/ServerScriptService/Old.meta.json"), false)
	assert.strictEqual(json(result, "default.project.json").emitLegacyScripts, true)
})

test("a place without LocalScripts uses modern mode, where only legacy Scripts need a meta file", () => {
	const result = buildRojoExport([file("ServerScriptService/Main.server.luau"), file("ServerScriptService/Old.legacy.luau")], null, "Game")
	assert.strictEqual(result.legacyMode, false)
	assert.strictEqual(result.files.has("src/ServerScriptService/Main.meta.json"), false)
	assert.deepStrictEqual(json(result, "src/ServerScriptService/Old.meta.json").properties, { RunContext: "Legacy" })
	const project = json(result, "default.project.json")
	assert.deepStrictEqual(project.tree.ServerScriptService, { $path: "src/ServerScriptService", $ignoreUnknownInstances: true })
	assert.strictEqual(project.tree.ReplicatedStorage, undefined)
})

test("containers keep their class, folders keep unknown instances, and script folders get no className", () => {
	const map = {
		name: "Game",
		className: "DataModel",
		children: [
			{
				name: "StarterGui",
				className: "StarterGui",
				children: [
					{ name: "HUD", className: "ScreenGui", children: [{ name: "Controller", className: "LocalScript", filePaths: ["StarterGui/HUD/Controller.local.luau"], children: [{ name: "Frame", className: "Frame" }] }] },
					{ name: "Shop", className: "ModuleScript", filePaths: ["StarterGui/Shop/init.luau"], children: [{ name: "Item", className: "ModuleScript", filePaths: ["StarterGui/Shop/Item.luau"] }] },
				],
			},
		],
	}
	const result = buildRojoExport([file("StarterGui/HUD/Controller.local.luau"), file("StarterGui/Shop/init.luau"), file("StarterGui/Shop/Item.luau")], map, "Game")
	assert.deepStrictEqual(json(result, "src/StarterGui/HUD/init.meta.json"), { ignoreUnknownInstances: true, className: "ScreenGui" })
	assert.deepStrictEqual(json(result, "src/StarterGui/HUD/Controller.meta.json"), { ignoreUnknownInstances: true })
	assert.deepStrictEqual(json(result, "src/StarterGui/Shop/init.meta.json"), { ignoreUnknownInstances: true })
	assert.strictEqual(result.files.get("src/StarterGui/Shop/init.luau"), "-- StarterGui/Shop/init.luau\n")
})

test("names Rojo can't represent are reported", () => {
	const result = buildRojoExport([file("ReplicatedStorage/A%2FB.luau"), file("ReplicatedStorage/Dup~abc123/Kid.luau"), file("ReplicatedStorage/Fine.luau")], null, "Game")
	assert.strictEqual(result.warnings.length, 2)
	assert.ok(result.warnings.some((w) => w.includes("A%2FB")))
	assert.ok(result.warnings.some((w) => w.includes("Dup~abc123")))
})
