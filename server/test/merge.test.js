"use strict"

const test = require("node:test")
const assert = require("node:assert")
const { merge3 } = require("../merge")

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

test("edits to different parts of a script merge", () => {
	const base = lines(20).join("\n")
	const ours = lines(20).map((l, i) => (i === 1 ? "top edit" : l)).join("\n")
	const theirs = lines(20).map((l, i) => (i === 18 ? "bottom edit" : l)).join("\n")
	const result = merge3(base, ours, theirs)
	assert.ok(result.clean)
	assert.match(result.text, /top edit/)
	assert.match(result.text, /bottom edit/)
	assert.strictEqual(result.text.split("\n").length, 20)
})

test("insertions and deletions on separate lines merge", () => {
	const base = lines(10).join("\n")
	const ours = ["header", ...lines(10)].join("\n")
	const theirs = lines(10).filter((_, i) => i !== 7).join("\n")
	const result = merge3(base, ours, theirs)
	assert.ok(result.clean)
	assert.strictEqual(result.text, ["header", ...lines(10).filter((_, i) => i !== 7)].join("\n"))
})

test("adjacent line edits merge", () => {
	const base = lines(5).join("\n")
	const ours = lines(5).map((l, i) => (i === 2 ? "A" : l)).join("\n")
	const theirs = lines(5).map((l, i) => (i === 3 ? "B" : l)).join("\n")
	const result = merge3(base, ours, theirs)
	assert.ok(result.clean)
	assert.deepStrictEqual(result.text.split("\n"), ["line 1", "line 2", "A", "B", "line 5"])
})

test("overlapping edits conflict", () => {
	const base = lines(5).join("\n")
	const ours = lines(5).map((l, i) => (i === 2 ? "A" : l)).join("\n")
	const theirs = lines(5).map((l, i) => (i === 2 ? "B" : l)).join("\n")
	assert.strictEqual(merge3(base, ours, theirs).clean, false)
})

test("identical edits on both sides merge", () => {
	const base = lines(5).join("\n")
	const both = lines(5).map((l, i) => (i === 2 ? "same" : l)).join("\n")
	const other = both.replace("line 5", "line 5!")
	assert.deepStrictEqual(merge3(base, both, other), { clean: true, text: other })
})

test("large rewrites still produce a result", () => {
	const base = lines(3000).join("\n")
	const ours = lines(3000).map((l) => l + "x").join("\n")
	const theirs = base + "\nappended"
	assert.strictEqual(merge3(base, ours, theirs).clean, false)
	assert.strictEqual(merge3(base, ours, base).text, ours)
})
