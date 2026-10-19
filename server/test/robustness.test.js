"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { PlaceSync } = require("../sync")
const { sanitizeOwner } = require("../index")

const entry = (id, names, kind = "module", isDir = false, source) => ({
	id,
	segments: names.map((name) => ({ name })),
	kind,
	isDir,
	...(source === undefined ? {} : { source }),
})

async function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cinq-robust-"))
	const sync = new PlaceSync(path.join(root, "Cinq", "Test"), "123", "Test")
	await sync.load()
	sync.startWatching = () => {}
	t.after(() => {
		sync.stop()
		fs.rmSync(root, { recursive: true, force: true })
	})
	const send = async (...events) => {
		sync.handleEvents(events)
		await sync.queue
	}
	const abs = (rel) => path.join(sync.dir, ...rel.split("/"))
	const read = (rel) => fs.readFileSync(abs(rel), "utf8")
	const exists = (rel) => fs.existsSync(abs(rel))
	const reconcile = () => sync.run(() => sync.reconcile())
	const takeOps = () => {
		const ops = sync.outbox
		sync.outbox = []
		return ops
	}
	return { sync, send, read, exists, abs, reconcile, takeOps }
}

// Makes fs.promises.<method> fail with EPERM for paths matching `when`, for the rest of the test.
function failFs(t, method, when) {
	const original = fs.promises[method]
	fs.promises[method] = async (...args) => {
		if (args.some((arg) => typeof arg === "string" && when(arg))) throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" })
		return original.apply(fs.promises, args)
	}
	t.after(() => (fs.promises[method] = original))
}

test("a rename that fails on disk keeps the file where it was instead of deleting the script", async (t) => {
	const { sync, send, read, exists, reconcile, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerStorage", "A"], "module", false, "precious")] })
	takeOps()
	failFs(t, "rename", (p) => p.endsWith(`${path.sep}B.luau`))
	await send({ type: "tree", entries: [entry("a1", ["ServerStorage", "B"])] })
	assert.strictEqual(read("ServerStorage/A.luau"), "precious")
	assert.ok(!exists("ServerStorage/B.luau"))
	assert.strictEqual(sync.scripts.get("a1").path, "ServerStorage/A.luau")
	await reconcile()
	assert.ok(!takeOps().some((op) => op.op === "delete"), "no delete is sent to Studio")
})

test("a file that can't be written while connecting doesn't stop the rest of the place", async (t) => {
	const { sync, send, read, exists } = await setup(t)
	await send({
		type: "snapshot",
		final: true,
		entries: [entry("a1", ["ServerStorage", "A"], "module", false, "a"), entry("b2", ["ServerStorage", "B"], "module", false, "b")],
	})
	sync.stop()
	const next = new PlaceSync(sync.dir, "123", "Test")
	await next.load()
	next.startWatching = () => {}
	t.after(() => next.stop())
	fs.unlinkSync(path.join(sync.dir, "ServerStorage", "A.luau"))
	failFs(t, "writeFile", (p) => p.endsWith(`${path.sep}A.luau`))
	next.handleEvents([
		{
			type: "snapshot",
			final: true,
			entries: [entry("a1", ["ServerStorage", "A"], "module", false, "a2"), entry("b2", ["ServerStorage", "B"], "module", false, "b2")],
		},
	])
	await next.queue
	assert.ok(next.ready, "the place still becomes ready")
	assert.strictEqual(read("ServerStorage/B.luau"), "b2")
	assert.ok(next.held.has("a1"))
	await next.run(() => next.reconcile())
	assert.ok(!next.outbox.some((op) => op.op === "delete"), "the held script's missing file isn't read as a delete")
	assert.ok(!exists("ServerStorage/A.luau"))
})

test("state.json is replaced atomically", async (t) => {
	const { sync, send } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerStorage", "A"], "module", false, "a")] })
	sync.saveNow()
	assert.ok(!fs.existsSync(`${sync.stateFile}.tmp`))
	assert.strictEqual(JSON.parse(fs.readFileSync(sync.stateFile, "utf8")).scripts.a1.synced, "a")
})

test("a replaced session doesn't save over its successor", async (t) => {
	const { sync, send } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerStorage", "A"], "module", false, "a")] })
	sync.stop()
	fs.writeFileSync(sync.stateFile, JSON.stringify({ placeId: "123", scripts: {} }))
	sync.dirty()
	await new Promise((resolve) => setTimeout(resolve, 600))
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(sync.stateFile, "utf8")).scripts, {})
})

test("a path whose escapes only differ in letter case isn't sent to Studio as a move", async (t) => {
	const { sync, send, abs, reconcile, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerStorage", "a/b"], "module", false, "x")] })
	takeOps()
	fs.renameSync(abs("ServerStorage/a%2Fb.luau"), abs("ServerStorage/a%2fb.luau"))
	await reconcile()
	assert.strictEqual(takeOps().length, 0)
	assert.strictEqual(sync.scripts.get("a1").path, "ServerStorage/a%2fb.luau")
})

test("a folder renamed only in letter case in Studio is renamed on disk too", { skip: !["win32", "darwin"].includes(process.platform) }, async (t) => {
	const { sync, send, abs } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerStorage", "Utils", "A"], "module", false, "x")] })
	await send({ type: "tree", entries: [entry("a1", ["ServerStorage", "utils", "A"])] })
	assert.deepStrictEqual(fs.readdirSync(abs("ServerStorage")), ["utils"])
	assert.strictEqual(sync.scripts.get("a1").path, "ServerStorage/utils/A.luau")
})

test("a tree change skipped while an op was in flight asks Studio for a fresh tree", async (t) => {
	const { sync, send, abs, reconcile, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerStorage", "A"], "module", false, "x")] })
	takeOps()
	fs.writeFileSync(abs("ServerStorage/A.luau"), "y")
	await reconcile()
	const [update] = takeOps()
	assert.strictEqual(update.op, "update")
	await send({ type: "tree", entries: [entry("a1", ["ServerStorage", "B"])] })
	assert.strictEqual(sync.scripts.get("a1").path, "ServerStorage/A.luau", "skipped while the update is in flight")
	await send({ type: "applied", opId: update.opId, ok: true, source: "y" })
	assert.ok(takeOps().some((op) => op.op === "rescan"))
})

test("the awake owner only accepts a positive integer pid and a string label", () => {
	assert.deepStrictEqual(sanitizeOwner({ pid: 1234, label: "Claude closes" }), { pid: 1234, label: "Claude closes" })
	assert.strictEqual(sanitizeOwner({ pid: "1) -or (Start-Process calc", label: "x" }), null)
	assert.strictEqual(sanitizeOwner({ pid: 12.5, label: "x" }), null)
	assert.strictEqual(sanitizeOwner({ pid: -1, label: "x" }), null)
	assert.strictEqual(sanitizeOwner({ pid: 1234, label: 5 }), null)
	assert.strictEqual(sanitizeOwner(null), null)
})
