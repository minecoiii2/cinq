"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { resolvePlaceDir, listPlaceDirs, placeKey } = require("../places")

function setup(t) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cinq-places-"))
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
	const root = path.join(temp, "Cinq")
	const claim = (name, placeId) => {
		fs.mkdirSync(path.join(root, name, ".cinq"), { recursive: true })
		fs.writeFileSync(path.join(root, name, ".cinq", "state.json"), JSON.stringify({ placeId, scripts: {} }))
	}
	const name = (dir) => path.basename(dir)
	return { temp, root, claim, name }
}

test("published places are named by PlaceId, unpublished ones by encoded file name", (t) => {
	const { root, name } = setup(t)
	assert.strictEqual(name(resolvePlaceDir(root, "105", "Game")), "105")
	assert.strictEqual(name(resolvePlaceDir(root, "0", "My Game: Remastered.rbxl")), "My Game%3A Remastered.rbxl")
	assert.strictEqual(name(resolvePlaceDir(root, "0", "   ")), "Untitled")
})

test("published places in name-based folders move to their PlaceId folder", (t) => {
	const { root, claim, name } = setup(t)
	claim("Plugin Expirement 2", "105")
	fs.mkdirSync(path.join(root, "Plugin Expirement 2", "ServerScriptService"))
	assert.strictEqual(name(resolvePlaceDir(root, "105", "Whatever")), "Plugin Expirement 2")
	const dir = resolvePlaceDir(root, "105", "Whatever", { rename: true })
	assert.strictEqual(name(dir), "105")
	assert.ok(fs.existsSync(path.join(dir, "ServerScriptService")))
})

test("a published place never takes over an unpublished place's folder", (t) => {
	const { root, claim, name } = setup(t)
	claim("Lobby", "0")
	assert.strictEqual(name(resolvePlaceDir(root, "7", "Lobby")), "7")
	assert.strictEqual(name(resolvePlaceDir(root, "0", "Lobby")), "Lobby")
})

test("unpublished places are matched by name", (t) => {
	const { root, claim, name } = setup(t)
	claim("Place1", "0")
	assert.strictEqual(name(resolvePlaceDir(root, "0", "Place1")), "Place1")
	assert.strictEqual(name(resolvePlaceDir(root, "0", "Place2")), "Place2")
})

test("linked places sync into their own folder, by PlaceId or unpublished file name", (t) => {
	const { temp, root, claim } = setup(t)
	claim("105", "105")
	const repo = path.join(temp, "MyGame", "src")
	const links = { 105: repo, [placeKey("0", "Lobby.rbxl")]: path.join(temp, "Lobby") }
	assert.strictEqual(resolvePlaceDir(root, "105", "Game", { rename: true, links }), repo)
	assert.strictEqual(resolvePlaceDir(root, "0", "Lobby.rbxl", { links }), path.join(temp, "Lobby"))
	assert.strictEqual(path.basename(resolvePlaceDir(root, "7", "Other", { links })), "7")
})

test("listing places includes linked folders that exist", (t) => {
	const { temp, root, claim } = setup(t)
	claim("105", "105")
	const repo = path.join(temp, "MyGame")
	fs.mkdirSync(repo)
	const dirs = listPlaceDirs(root, { root: null, links: { 7: repo, 8: path.join(temp, "missing") } })
	assert.deepStrictEqual(
		dirs.map((d) => [d.name, d.linked]),
		[["105", false], ["MyGame", "7"]]
	)
})
