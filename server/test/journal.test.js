"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { Journal, unifiedDiff } = require("../journal")

const read = (file) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))

function setup(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cinq-journal-"))
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
	return path.join(dir, "journal.jsonl")
}

test("unified diffs show changed lines with context", () => {
	const { diff, added, removed } = unifiedDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nD\ne\nf\ng")
	assert.deepStrictEqual([added, removed], [1, 1])
	assert.strictEqual(diff, "@@ -2,5 +2,5 @@\n b\n c\n-d\n+D\n e\n f")
})

test("bursts of edits become one entry", (t) => {
	const file = setup(t)
	const journal = new Journal(file)
	journal.edit("studio", "a1", "S/M.luau", "1\n2\n3", "1\n2\n3!")
	journal.edit("studio", "a1", "S/M.luau", "1\n2\n3!", "one\n2\n3!")
	journal.edit("disk", "a1", "S/M.luau", "x", "y")
	journal.flush()
	const entries = read(file)
	assert.strictEqual(entries.length, 2)
	const studio = entries.find((e) => e.origin === "studio")
	assert.deepStrictEqual([studio.added, studio.removed], [2, 2])
	assert.match(studio.diff, /\+one/)
	assert.match(studio.diff, /\+3!/)
})

test("edits that cancel out leave no entry", (t) => {
	const file = setup(t)
	const journal = new Journal(file)
	journal.edit("studio", "a1", "S/M.luau", "x", "y")
	journal.edit("studio", "a1", "S/M.luau", "y", "x")
	journal.flush()
	assert.ok(!fs.existsSync(file))
})

test("events close the open edit for that path first", (t) => {
	const file = setup(t)
	const journal = new Journal(file)
	journal.edit("studio", "a1", "S/M.luau", "x", "y")
	journal.event("studio", "delete", "S/M.luau")
	assert.deepStrictEqual(
		read(file).map((e) => e.kind),
		["edit", "delete"]
	)
})
