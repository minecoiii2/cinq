"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { resolvePlaceDir } = require("../places")

function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cinq-places-"))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const claim = (name, placeId) => {
		fs.mkdirSync(path.join(root, "Cinq", name, ".cinq"), { recursive: true })
		fs.writeFileSync(path.join(root, "Cinq", name, ".cinq", "state.json"), JSON.stringify({ placeId, scripts: {} }))
	}
	const name = (dir) => path.basename(dir)
	return { root, claim, name }
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
	fs.mkdirSync(path.join(root, "Cinq", "Plugin Expirement 2", "ServerScriptService"))
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
