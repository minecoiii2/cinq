"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { PlaceSync } = require("../sync")

const svc = (name) => ({ name })
const entry = (id, names, kind = "module", isDir = false, source) => ({
	id,
	segments: [svc(names[0]), ...names.slice(1).map((name) => ({ name }))],
	kind,
	isDir,
	...(source === undefined ? {} : { source }),
})

async function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cinq-"))
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
	const read = (rel) => fs.readFileSync(path.join(sync.dir, rel), "utf8")
	const write = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(sync.dir, rel)), { recursive: true })
		fs.writeFileSync(path.join(sync.dir, rel), text)
	}
	const exists = (rel) => fs.existsSync(path.join(sync.dir, rel))
	const reconcile = () => sync.run(() => sync.reconcile())
	const takeOps = () => {
		const ops = sync.outbox
		sync.outbox = []
		return ops
	}
	return { sync, send, read, write, exists, reconcile, takeOps }
}

test("snapshot writes the Studio tree to disk", async (t) => {
	const { send, read, exists } = await setup(t)
	await send({
		type: "snapshot",
		final: true,
		entries: [
			entry("a1", ["ServerScriptService", "Main"], "server", false, "print('main')"),
			entry("b2", ["ReplicatedStorage", "Lib"], "module", true, "return {}"),
			entry("c3", ["ReplicatedStorage", "Lib", "Child"], "module", false, "return 1"),
			entry("d4", ["ReplicatedStorage", "Bad/Name"], "module", false, "return 2"),
		],
	})
	assert.strictEqual(read("ServerScriptService/Main.server.luau"), "print('main')")
	assert.strictEqual(read("ReplicatedStorage/Lib/init.luau"), "return {}")
	assert.strictEqual(read("ReplicatedStorage/Lib/Child.luau"), "return 1")
	assert.ok(exists("ReplicatedStorage/Bad%2FName.luau"))
})

test("disk edits become update ops and acks settle them", async (t) => {
	const { sync, send, write, reconcile, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "Main"], "server", false, "old")] })
	takeOps()
	write("ServerScriptService/Main.server.luau", "new")
	await reconcile()
	const [op] = takeOps()
	assert.deepStrictEqual([op.op, op.id, op.base, op.source], ["update", "a1", "old", "new"])
	await send({ type: "applied", opId: op.opId, ok: true, source: "new" })
	assert.strictEqual(sync.scripts.get("a1").synced, "new")
	await reconcile()
	assert.strictEqual(takeOps().length, 0)
})

test("concurrent Studio and disk edits to different lines merge", async (t) => {
	const { send, read, write, takeOps } = await setup(t)
	const base = ["a", "b", "c", "d", "e"].join("\n")
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, base)] })
	write("ServerScriptService/M.luau", ["A", "b", "c", "d", "e"].join("\n"))
	await send({ type: "source", id: "a1", source: ["a", "b", "c", "d", "E"].join("\n") })
	const merged = ["A", "b", "c", "d", "E"].join("\n")
	assert.strictEqual(read("ServerScriptService/M.luau"), merged)
	const [op] = takeOps()
	assert.deepStrictEqual([op.op, op.source], ["update", merged])
})

test("conflicting edits keep Studio's version and back up the disk copy", async (t) => {
	const { sync, send, read, write } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "x")] })
	write("ServerScriptService/M.luau", "disk")
	await send({ type: "source", id: "a1", source: "studio" })
	assert.strictEqual(read("ServerScriptService/M.luau"), "studio")
	const [id] = fs.readdirSync(path.join(sync.metaDir, "conflicts"))
	const record = path.join(sync.metaDir, "conflicts", id)
	assert.strictEqual(JSON.parse(fs.readFileSync(path.join(record, "info.json"), "utf8")).kind, "conflict")
	assert.deepStrictEqual(
		["base", "studio", "disk"].map((name) => fs.readFileSync(path.join(record, `${name}.luau`), "utf8")),
		["x", "studio", "disk"]
	)
})

test("Studio renames move files, including into init folders", async (t) => {
	const { send, read, exists } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ReplicatedStorage", "Util"], "module", false, "return 1")] })
	await send({
		type: "tree",
		entries: [entry("a1", ["ReplicatedStorage", "Utils"], "module", true), entry("b2", ["ReplicatedStorage", "Utils", "Sub"], "module", false, "return 2")],
	})
	assert.ok(!exists("ReplicatedStorage/Util.luau"))
	assert.strictEqual(read("ReplicatedStorage/Utils/init.luau"), "return 1")
	assert.strictEqual(read("ReplicatedStorage/Utils/Sub.luau"), "return 2")
	await send({ type: "tree", entries: [entry("a1", ["ReplicatedStorage", "Utils"], "module", false)] })
	assert.ok(!exists("ReplicatedStorage/Utils"))
	assert.strictEqual(read("ReplicatedStorage/Utils.luau"), "return 1")
})

test("new, moved and deleted files become create, move and delete ops", async (t) => {
	const { sync, send, write, reconcile, takeOps } = await setup(t)
	await send({
		type: "snapshot",
		final: true,
		entries: [entry("a1", ["ServerScriptService", "Keep"], "module", false, "keep"), entry("b2", ["ServerScriptService", "Gone"], "module", false, "gone")],
	})
	takeOps()
	fs.renameSync(path.join(sync.dir, "ServerScriptService/Keep.luau"), path.join(sync.dir, "ServerScriptService/Kept.client.luau"))
	fs.rmSync(path.join(sync.dir, "ServerScriptService/Gone.luau"))
	write("ServerScriptService/Folder/New.server.luau", "new")
	await reconcile()
	const ops = Object.fromEntries(takeOps().map((op) => [op.op, op]))
	assert.deepStrictEqual([ops.move.id, ops.move.kind, ops.move.segments.at(-1).name], ["a1", "client", "Kept"])
	assert.strictEqual(ops.delete.id, "b2")
	assert.deepStrictEqual(ops.create.segments.map((s) => s.name), ["ServerScriptService", "Folder", "New"])
	assert.strictEqual(ops.create.source, "new")
	await send({ type: "applied", opId: ops.create.opId, ok: true, source: "new" })
	assert.strictEqual(sync.scripts.get(ops.create.id).pending, undefined)
})

test("a move Studio refuses puts the file back and removes the emptied directory", async (t) => {
	const { sync, send, exists, reconcile, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["StarterGui", "HUD", "Controller"], "local", false, "x")] })
	takeOps()
	fs.renameSync(path.join(sync.dir, "StarterGui/HUD"), path.join(sync.dir, "StarterGui/HUD2"))
	await reconcile()
	const [op] = takeOps()
	assert.strictEqual(op.op, "move")
	await send({ type: "applied", opId: op.opId, ok: false, error: "StarterGui.HUD is a ScreenGui" })
	assert.ok(exists("StarterGui/HUD/Controller.local.luau"))
	assert.ok(!exists("StarterGui/HUD2"))
})

test("mass disappearance restores files instead of deleting scripts", async (t) => {
	const { sync, send, exists, reconcile, takeOps } = await setup(t)
	const entries = Array.from({ length: 8 }, (_, i) => entry(`id${i}`, ["ServerScriptService", `S${i}`], "module", false, `return ${i}`))
	await send({ type: "snapshot", final: true, entries })
	takeOps()
	fs.rmSync(path.join(sync.dir, "ServerScriptService"), { recursive: true })
	await reconcile()
	assert.strictEqual(takeOps().length, 0)
	assert.ok(exists("ServerScriptService/S3.luau"))
})

test("a script whose CinqId changed is relinked instead of recreated", async (t) => {
	const { sync, send, read, write } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "1\n2\n3")] })
	write("ServerScriptService/M.luau", "one\n2\n3")
	await send({ type: "tree", entries: [entry("z9", ["ServerScriptService", "M"], "module", false, "1\n2\n3")] })
	assert.ok(!sync.scripts.has("a1"))
	assert.strictEqual(sync.scripts.get("z9").path, "ServerScriptService/M.luau")
	assert.strictEqual(read("ServerScriptService/M.luau"), "one\n2\n3")
	assert.ok(!fs.existsSync(path.join(sync.metaDir, "conflicts")))
})

test("a renamed script with a new CinqId is relinked by content", async (t) => {
	const { sync, send, exists } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "Old"], "module", false, "return 'unique'")] })
	await send({ type: "tree", entries: [entry("z9", ["ServerScriptService", "New"], "module", false, "return 'unique'")] })
	assert.strictEqual(sync.scripts.get("z9").path, "ServerScriptService/New.luau")
	assert.ok(!exists("ServerScriptService/Old.luau"))
})

test("case-only renames on disk rename the instance", async (t) => {
	const { sync, send, reconcile, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "foo"], "module", false, "x")] })
	takeOps()
	fs.renameSync(path.join(sync.dir, "ServerScriptService/foo.luau"), path.join(sync.dir, "ServerScriptService/Foo.luau"))
	await reconcile()
	const [op] = takeOps()
	assert.deepStrictEqual([op.op, op.segments.at(-1).name], ["move", "Foo"])
})

test("scripts removed in Studio while disconnected keep a copy", async (t) => {
	const { sync, send, exists } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "keep me")] })
	sync.stop()
	const again = new PlaceSync(sync.dir, "123", "Test")
	await again.load()
	again.startWatching = () => {}
	t.after(() => again.stop())
	again.handleEvents([{ type: "snapshot", final: true, entries: [] }])
	await again.queue
	assert.ok(!exists("ServerScriptService/M.luau"))
	const [stamp] = fs.readdirSync(path.join(again.metaDir, "removed"))
	assert.strictEqual(fs.readFileSync(path.join(again.metaDir, "removed", stamp, "ServerScriptService", "M.luau"), "utf8"), "keep me")
})

test("Studio edits are attributed only while the editor stamp matches the source", async (t) => {
	const { sync, send } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "x")] })
	assert.strictEqual(sync.editorOf("héllo\n", { by: 42, byHash: "cafdd37e" }), "42")
	await send({ type: "source", id: "a1", source: "héllo\n", by: 42, byHash: "cafdd37e" })
	await send({ type: "source", id: "a1", source: "edited by someone else", by: 42, byHash: "cafdd37e" })
	sync.journal.flush()
	const entries = fs
		.readFileSync(path.join(sync.metaDir, "journal.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
	assert.deepStrictEqual(
		entries.map((e) => e.by),
		["42", "unknown"]
	)
})

test("CRLF scripts and files are treated as LF and never pushed back", async (t) => {
	const { sync, send, read, write, reconcile, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "a\r\nb\r\n")] })
	assert.strictEqual(read("ServerScriptService/M.luau"), "a\nb\n")
	write("ServerScriptService/M.luau", "a\r\nb\r\n")
	sync.stats.clear()
	await reconcile()
	await send({ type: "source", id: "a1", source: "a\r\nb\r\n" })
	assert.strictEqual(takeOps().length, 0)
})

test("waitSettled resolves only once Studio has acknowledged every disk change", async (t) => {
	const { sync, send, write, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "old")] })
	assert.deepStrictEqual((await sync.waitSettled(1000)).settled, true)
	write("ServerScriptService/M.luau", "new")
	assert.deepStrictEqual((await sync.waitSettled(150)).settled, false)
	const [op] = takeOps()
	await send({ type: "applied", opId: op.opId, ok: true, source: "new" })
	assert.deepStrictEqual((await sync.waitSettled(1000)).settled, true)
})

test("reconnecting merges edits made while disconnected", async (t) => {
	const { sync, send, write, read, takeOps } = await setup(t)
	await send({ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "1\n2\n3\n4")] })
	sync.stop()
	const again = new PlaceSync(sync.dir, "123", "Test")
	await again.load()
	again.startWatching = () => {}
	t.after(() => again.stop())
	write("ServerScriptService/M.luau", "one\n2\n3\n4")
	again.handleEvents([{ type: "snapshot", final: true, entries: [entry("a1", ["ServerScriptService", "M"], "module", false, "1\n2\n3\nfour")] }])
	await again.queue
	assert.strictEqual(read("ServerScriptService/M.luau"), "one\n2\n3\nfour")
	assert.strictEqual(again.outbox[0].source, "one\n2\n3\nfour")
	takeOps()
})
