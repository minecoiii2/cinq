"use strict"

const test = require("node:test")
const assert = require("node:assert")
const { classify } = require("../drafts")

const base = "local a = 1\nlocal b = 2\nlocal c = 3\nreturn a + b + c\n"

test("a draft whose base is unknown is never merged", () => {
	assert.strictEqual(classify({ draft: "x", committed: "y" }).kind, "unknown")
})

test("a draft with no newer commit is only your edits", () => {
	const draft = base.replace("local a = 1", "local a = 100")
	assert.strictEqual(classify({ base, draft, committed: base }).kind, "mine")
})

test("a commit on other lines merges cleanly and keeps both sides", () => {
	const draft = base.replace("local a = 1", "local a = 100")
	const committed = base.replace("return a", "return 2 * a")
	const status = classify({ base, draft, committed })
	assert.strictEqual(status.kind, "behind")
	assert.strictEqual(status.merged, "local a = 100\nlocal b = 2\nlocal c = 3\nreturn 2 * a + b + c\n")
})

test("a draft that already includes the latest commit is only your edits", () => {
	const committed = base.replace("return a", "return 2 * a")
	const draft = committed.replace("local a = 1", "local a = 100")
	assert.strictEqual(classify({ base, draft, committed }).kind, "mine")
})

test("both sides changing the same line is a conflict", () => {
	const draft = base.replace("local c = 3", "local c = 30")
	const committed = base.replace("local c = 3", "local c = 33")
	assert.strictEqual(classify({ base, draft, committed }).kind, "conflict")
})
