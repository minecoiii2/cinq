"use strict"

const test = require("node:test")
const assert = require("node:assert")
const path = require("path")
const { parseProblems, compareToBaseline, countKeys } = require("../check")
const { buildSourcemap } = require("../sourcemap")

const dir = path.resolve("/place")
const output = [
	"[INFO] Loading definitions file: @roblox - defs.d.luau",
	"[WARN] client does not allow didChangeWatchedFiles registration",
	`${path.join(dir, "ServerScriptService", "A.server.luau")} [game/ServerScriptService/A](3,7): TypeError: Cannot call a value of the union type:`,
	"  | () -> number",
	"  | string",
	`${path.join(dir, "ServerScriptService", "A.server.luau")} [game/ServerScriptService/A](9,1): LocalUnused: Variable 'x' is never used`,
	`${path.join(dir, "ReplicatedStorage", "B.luau")}(1,1): LocalUnused: Variable 'x' is never used`,
].join("\r\n")

test("luau-lsp output is parsed with module names stripped and continuation lines kept", () => {
	const problems = parseProblems(output, dir)
	assert.strictEqual(problems.length, 3)
	assert.strictEqual(problems[0].file, path.join(dir, "ServerScriptService", "A.server.luau"))
	assert.deepStrictEqual([problems[0].row, problems[0].column, problems[0].kind], [3, 7, "TypeError"])
	assert.deepStrictEqual(problems[0].more, ["| () -> number", "| string"])
	assert.strictEqual(problems[2].file, path.join(dir, "ReplicatedStorage", "B.luau"))
})

test("only problems beyond the baseline count are new, whatever line they moved to", () => {
	const baseline = countKeys(parseProblems(output, dir), dir)
	const moved = output.replace("(9,1)", "(40,1)")
	assert.strictEqual(compareToBaseline(parseProblems(moved, dir), baseline, dir, () => true).fresh.length, 0)
	const extra = `${moved}\r\n${path.join(dir, "ReplicatedStorage", "B.luau")}(7,1): LocalUnused: Variable 'x' is never used`
	const { fresh } = compareToBaseline(parseProblems(extra, dir), baseline, dir, () => true)
	assert.strictEqual(fresh.length, 2, "both occurrences of the key that grew are shown")
})

test("fixed problems leave the baseline, but only for the files that were checked", () => {
	const baseline = countKeys(parseProblems(output, dir), dir)
	const onlyB = parseProblems(output, dir).filter((p) => p.file.endsWith("B.luau"))
	const inA = (rel) => rel.startsWith("ServerScriptService/")
	const { tightened } = compareToBaseline([], baseline, dir, inA)
	assert.deepStrictEqual(Object.keys(tightened), Object.keys(countKeys(onlyB, dir)))
})

test("sourcemap nodes point synced scripts at their files and unsynced ones at copies", () => {
	const nodes = [
		["ReplicatedStorage", "ReplicatedStorage", 0, [
			["Util", "ModuleScript", "abc", [["Inner", "ModuleScript", "def", []]]],
			["Pkg", "ModuleScript", 0, [["PackageLink", "PackageLink", 0, []]], "return {}"],
			["Remotes", "Folder", 0, [["Fire", "RemoteEvent", 0, []]]],
		]],
	]
	const files = { abc: "ReplicatedStorage/Util/init.luau", def: "ReplicatedStorage/Util/Inner.luau" }
	const { map, instances, scripts, unsynced } = buildSourcemap(nodes, (id) => files[id])
	assert.strictEqual(map.className, "DataModel")
	const [util, pkg, remotes] = map.children[0].children
	assert.deepStrictEqual(util.filePaths, ["ReplicatedStorage/Util/init.luau"])
	assert.deepStrictEqual(util.children[0].filePaths, ["ReplicatedStorage/Util/Inner.luau"])
	assert.deepStrictEqual(pkg.filePaths, [unsynced[0].file])
	assert.strictEqual(unsynced[0].source, "return {}")
	assert.strictEqual(remotes.children[0].className, "RemoteEvent")
	assert.strictEqual(remotes.filePaths, undefined)
	assert.deepStrictEqual([instances, scripts, unsynced.length], [7, 2, 1])
})
