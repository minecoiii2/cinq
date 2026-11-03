"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { compareVersions, pluginMismatch, hashPluginSource } = require("../version")

const server = { version: "0.2.0", build: "abc" }

test("versions compare numerically", () => {
	assert.strictEqual(compareVersions("0.10.0", "0.9.1"), 1)
	assert.strictEqual(compareVersions("0.2", "0.2.0"), 0)
	assert.strictEqual(compareVersions("0.1.1", "0.2.0"), -1)
})

test("a plugin is matched against the server's version and build", () => {
	assert.strictEqual(pluginMismatch({ version: "0.2.0", build: "abc" }, server), null)
	assert.match(pluginMismatch({}, server), /older than the server.*cinq install-plugin/)
	assert.match(pluginMismatch({ version: "0.1.1", build: "abc" }, server), /plugin \(0\.1\.1\) is older.*cinq install-plugin/)
	assert.match(pluginMismatch({ version: "0.3.0", build: "abc" }, server), /server \(0\.2\.0\) is older.*cinq update/)
	assert.match(pluginMismatch({ version: "0.2.0", build: "def" }, server), /different source.*cinq install-plugin/)
})

test("the plugin source hash ignores line endings and non-Luau files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cinq-version-"))
	try {
		fs.writeFileSync(path.join(dir, "A.luau"), "return 1\nreturn 2\n")
		const lf = hashPluginSource(dir)
		fs.writeFileSync(path.join(dir, "A.luau"), "return 1\r\nreturn 2\r\n")
		fs.writeFileSync(path.join(dir, "notes.txt"), "ignored")
		assert.strictEqual(hashPluginSource(dir), lf)
		fs.writeFileSync(path.join(dir, "A.luau"), "return 3\n")
		assert.notStrictEqual(hashPluginSource(dir), lf)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
