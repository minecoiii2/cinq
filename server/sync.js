"use strict"

const fs = require("fs")
const fsp = fs.promises
const path = require("path")
const crypto = require("crypto")
const { SERVICES, scriptPath, parsePath } = require("./paths")
const { merge3, diffHunks } = require("./merge")
const { Journal } = require("./journal")
const log = require("./log")
const { SOURCEMAP_FILE, UNSYNCED_DIR, buildSourcemap, writeEditorSettings } = require("./sourcemap")

const POLL_HOLD_MS = 15000
const WATCH_DEBOUNCE_MS = 25
const FALLBACK_SCAN_MS = 2000
const MASS_DELETE_MIN = 5
const MASS_DELETE_RATIO = 0.5
const SOURCEMAP_DEBOUNCE_MS = 3000
const DATAMODEL_TIMEOUT_MS = 60000

const key = (rel) => rel.toLowerCase()
const newId = () => crypto.randomBytes(5).toString("hex")
const statSig = (s) => `${s.mtimeMs}:${s.size}`
const depth = (entry) => entry.segments.length
const baseName = (rel) => rel.slice(rel.lastIndexOf("/") + 1)
// Studio's UpdateSourceAsync always stores LF, so both sides are compared and written in LF.
const normalize = (text) => text.replace(/\r\n/g, "\n")

function changeSummary(before, after) {
	const hunks = diffHunks((before ?? "").split("\n"), after.split("\n"))
	let added = 0
	let removed = 0
	for (const h of hunks) {
		added += h.b1 - h.b0
		removed += h.a1 - h.a0
	}
	return { added, removed, line: hunks.length > 0 ? hunks[0].b0 + 1 : 1 }
}

// 32-bit FNV-1a over the UTF-8 bytes; must match plugin/Hash.luau.
function fnv(text) {
	let hash = 0x811c9dc5
	for (const byte of Buffer.from(text, "utf8")) hash = Math.imul(hash ^ byte, 16777619) >>> 0
	return hash.toString(16).padStart(8, "0")
}

class PlaceSync {
	constructor(dir, placeId, placeName) {
		this.placeId = String(placeId)
		this.placeName = placeName
		this.dir = dir
		this.log = log.forPlace(path.basename(dir))
		this.connectedAt = Date.now()
		this.metaDir = path.join(this.dir, ".cinq")
		this.stateFile = path.join(this.metaDir, "state.json")
		this.journal = new Journal(path.join(this.metaDir, "journal.jsonl"))
		// id -> { path, synced, pending? }; `synced` is the last source both sides agreed on.
		this.scripts = new Map()
		this.users = {}
		this.stats = new Map()
		this.rejected = new Map()
		this.inflight = new Map()
		this.pending = new Map()
		this.outbox = []
		this.seq = 0
		this.opCounter = 0
		this.waiter = null
		this.queue = Promise.resolve()
		this.snapshot = []
		this.ready = false
		this.lastSeen = Date.now()
		this.tools = new Map()
		this.toolCounter = 0
	}

	async load() {
		await fsp.mkdir(this.metaDir, { recursive: true })
		try {
			const state = JSON.parse(await fsp.readFile(this.stateFile, "utf8"))
			for (const [id, st] of Object.entries(state.scripts ?? {})) this.scripts.set(id, { path: st.path, synced: st.synced })
			this.users = state.users ?? {}
		} catch (err) {
			if (err.code !== "ENOENT") this.log.warn(`Couldn't read ${this.stateFile}, starting fresh: ${err.message}`)
		}
	}

	saveNow() {
		clearTimeout(this.saveTimer)
		this.saveTimer = null
		const scripts = {}
		for (const [id, st] of this.scripts) if (!st.pending) scripts[id] = { path: st.path, synced: st.synced }
		fs.mkdirSync(this.metaDir, { recursive: true })
		fs.writeFileSync(this.stateFile, JSON.stringify({ version: 1, placeId: this.placeId, placeName: this.placeName, users: this.users, scripts }))
	}

	dirty() {
		if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 500)
	}

	run(fn) {
		this.queue = this.queue.then(fn).catch((err) => this.log.error(err.stack ?? String(err)))
		return this.queue
	}

	stop() {
		this.stopped = true
		this.watcher?.close()
		clearInterval(this.interval)
		clearTimeout(this.reconcileTimer)
		this.waiter?.resolve([])
		for (const finish of this.tools.values()) finish({ ok: false, error: "Studio disconnected" })
		this.tools.clear()
		this.journal.flush()
		this.saveNow()
	}

	requestTool(tool, args, timeoutMs) {
		const requestId = ++this.toolCounter
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.tools.delete(requestId)
				resolve({ ok: false, error: `Studio didn't answer within ${timeoutMs / 1000}s` })
			}, timeoutMs)
			this.tools.set(requestId, (result) => {
				clearTimeout(timer)
				resolve(result)
			})
			this.outbox.push({ op: "tool", requestId, tool, args, seq: ++this.seq })
			this.waiter?.resolve(this.outbox.slice())
		})
	}

	// Settled means every disk change has been scanned, sent to Studio and acknowledged.
	async waitSettled(timeoutMs) {
		const started = Date.now()
		for (;;) {
			await this.run(() => this.reconcile())
			if (this.ready && this.pending.size === 0 && this.inflight.size === 0) return { settled: true, ms: Date.now() - started }
			if (this.stopped || Date.now() - started > timeoutMs) return { settled: false, pending: this.pending.size, ms: Date.now() - started }
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	resolveTool(requestId, result) {
		const finish = this.tools.get(requestId)
		if (!finish) return
		this.tools.delete(requestId)
		if (typeof result.text === "string") result.text = this.linkFiles(result.text)
		finish(result)
	}

	async writeSourcemap() {
		const result = await this.requestTool("datamodel", {}, DATAMODEL_TIMEOUT_MS)
		if (!result.ok) throw new Error(`Studio couldn't list its instances: ${result.error}`)
		const { map, instances, scripts, unsynced } = buildSourcemap(JSON.parse(result.text), (id) => this.scripts.get(id)?.path)
		const copies = this.abs(UNSYNCED_DIR)
		await fsp.rm(copies, { recursive: true, force: true })
		await fsp.mkdir(copies, { recursive: true })
		for (const copy of unsynced) await fsp.writeFile(this.abs(copy.file), copy.source)
		const file = path.join(this.dir, SOURCEMAP_FILE)
		await fsp.writeFile(file, JSON.stringify(map))
		writeEditorSettings(this.dir)
		return { file, instances, scripts, unsynced: unsynced.length }
	}

	// Once a place has a sourcemap, keep it current as scripts are added, moved and removed.
	scheduleSourcemap() {
		if (!fs.existsSync(path.join(this.dir, SOURCEMAP_FILE))) return
		clearTimeout(this.sourcemapTimer)
		this.sourcemapTimer = setTimeout(() => {
			if (this.stopped) return
			this.writeSourcemap().catch((err) => this.log.warn(`Couldn't refresh ${SOURCEMAP_FILE}: ${err.message}`))
		}, SOURCEMAP_DEBOUNCE_MS)
	}

	// Tools mark synced scripts with ⟦file:<id>⟧; the CLI shortens these absolute paths to the caller's folder.
	linkFiles(text) {
		return text.replace(/⟦file:([^⟧]*)⟧/g, (_, id) => {
			const st = this.scripts.get(id)
			return st ? ` → ${this.abs(st.path).split(path.sep).join("/")}` : ""
		})
	}

	send(op) {
		op.opId = ++this.opCounter
		op.seq = ++this.seq
		if (op.op === "update" || op.op === "create") op.change = changeSummary(op.op === "create" ? "" : op.base, op.source)
		if (op.op !== "create" && op.op !== "move") op.path = this.scripts.get(op.id)?.path
		this.outbox.push(op)
		this.pending.set(op.opId, op)
		if (op.id) this.inflight.set(op.id, op.opId)
		this.waiter?.resolve(this.outbox.slice())
	}

	// For the plugin's activity panel only: never acknowledged, so it doesn't hold up `cinq wait`.
	notify(kind, rel, message, id) {
		this.outbox.push({ op: "notice", kind, path: rel, message, id, seq: ++this.seq })
		this.waiter?.resolve(this.outbox.slice())
	}

	poll(after) {
		this.lastSeen = Date.now()
		this.outbox = this.outbox.filter((op) => op.seq > after)
		if (this.outbox.length > 0 || this.stopped) return Promise.resolve(this.outbox.slice())
		this.waiter?.resolve([])
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.waiter?.resolve([]), POLL_HOLD_MS)
			this.waiter = {
				resolve: (ops) => {
					clearTimeout(timer)
					this.waiter = null
					resolve(ops)
				},
			}
		})
	}

	handleEvents(events) {
		this.lastSeen = Date.now()
		for (const ev of events) this.run(() => this.handleEvent(ev))
	}

	async handleEvent(ev) {
		if (this.stopped) return
		if (typeof ev.source === "string") ev.source = normalize(ev.source)
		for (const entry of ev.entries ?? []) if (typeof entry.source === "string") entry.source = normalize(entry.source)
		if (ev.type === "snapshot") {
			this.snapshot.push(...ev.entries)
			if (ev.final) {
				await this.initialSync(this.snapshot)
				this.snapshot = []
				this.scheduleSourcemap()
			}
		} else if (ev.type === "tree") {
			if (this.ready) {
				await this.onTree(ev.entries)
				this.scheduleSourcemap()
			}
		} else if (ev.type === "source") {
			if (this.ready) await this.onStudioSource(ev.id, ev.source, this.editorOf(ev.source, ev))
		} else if (ev.type === "users") {
			Object.assign(this.users, ev.names)
			this.dirty()
		} else if (ev.type === "applied") {
			await this.onApplied(ev)
		} else if (ev.type === "log") {
			this.log.warn(`Studio: ${ev.message}`)
		}
	}


	abs(rel) {
		return path.join(this.dir, ...rel.split("/"))
	}

	async readRel(rel) {
		try {
			return normalize(await fsp.readFile(this.abs(rel), "utf8"))
		} catch (err) {
			if (err.code === "ENOENT" || err.code === "EISDIR") return undefined
			throw err
		}
	}

	async recordStat(rel) {
		try {
			this.stats.set(key(rel), statSig(await fsp.stat(this.abs(rel))))
		} catch {
			this.stats.delete(key(rel))
		}
	}

	async writeRel(rel, text) {
		const file = this.abs(rel)
		await fsp.mkdir(path.dirname(file), { recursive: true })
		await fsp.writeFile(file, text)
		await this.recordStat(rel)
	}

	async removeRel(rel) {
		await fsp.rm(this.abs(rel), { force: true })
		this.stats.delete(key(rel))
		await this.prune(path.dirname(this.abs(rel)))
	}

	async prune(dir) {
		const roots = new Set([this.dir, ...SERVICES.map((s) => path.join(this.dir, s))].map((p) => p.toLowerCase()))
		while (dir.toLowerCase().startsWith(this.dir.toLowerCase()) && !roots.has(dir.toLowerCase())) {
			try {
				await fsp.rmdir(dir)
			} catch {
				return
			}
			dir = path.dirname(dir)
		}
	}

	// kind is "conflict" (both sides edited the same lines), "replaced" (an untracked file was overwritten)
	// or "removed" (Studio deleted a script whose file had unsynced edits).
	async backup(rel, disk, reason, { kind = "replaced", base, studio } = {}) {
		const time = new Date()
		const id = `${time.toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${crypto.randomBytes(2).toString("hex")}`
		const dir = path.join(this.metaDir, "conflicts", id)
		await fsp.mkdir(dir, { recursive: true })
		for (const [name, text] of [["disk.luau", disk], ["base.luau", base], ["studio.luau", studio]]) {
			if (text !== undefined) await fsp.writeFile(path.join(dir, name), text)
		}
		await fsp.writeFile(path.join(dir, "info.json"), JSON.stringify({ id, time: time.toISOString(), kind, path: rel, reason }))
		this.log.warn(`${reason}: ${rel} (see cinq conflicts, id ${id})`)
	}

	async keepRemoved(rel, text) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const file = path.join(this.metaDir, "removed", stamp, ...rel.split("/"))
		await fsp.mkdir(path.dirname(file), { recursive: true })
		await fsp.writeFile(file, text)
		this.log.warn(`Script was removed in Studio while Cinq was off: ${rel} (copy kept in ${path.relative(this.dir, file)})`)
	}

	async walk() {
		const files = new Map()
		const visit = async (rel) => {
			let entries
			try {
				entries = await fsp.readdir(this.abs(rel), { withFileTypes: true })
			} catch {
				return
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue
				const child = `${rel}/${entry.name}`
				if (entry.isDirectory()) await visit(child)
				else if (entry.isFile() && entry.name.toLowerCase().endsWith(".luau")) {
					try {
						files.set(key(child), { rel: child, sig: statSig(await fsp.stat(this.abs(child))) })
					} catch {}
				}
			}
		}
		for (const service of SERVICES) await visit(service)
		return files
	}


	// The stamp only counts if the source hasn't changed since; otherwise someone without Cinq edited it.
	editorOf(source, stamped) {
		return typeof stamped.by === "number" && fnv(source) === stamped.byHash ? String(stamped.by) : "unknown"
	}

	async onStudioSource(id, source, by) {
		const st = this.scripts.get(id)
		if (!st || st.pending || source === st.synced) return
		const disk = await this.readRel(st.path)
		if (disk === undefined || disk === st.synced) {
			await this.writeRel(st.path, source)
			this.journal.edit("studio", id, st.path, st.synced, source, by)
			st.synced = source
			this.log.studio(`→ ${st.path}`)
		} else if (disk === source) {
			st.synced = source
			await this.recordStat(st.path)
		} else {
			const merged = merge3(st.synced, disk, source)
			if (merged.clean) {
				await this.writeRel(st.path, merged.text)
				this.journal.edit("studio", id, st.path, st.synced, source, by)
				st.synced = source
				if (merged.text !== source) this.send({ op: "update", id, base: source, source: merged.text })
				this.log.info(`merged Studio and disk edits in ${st.path}`)
			} else {
				await this.backup(st.path, disk, "Conflicting edits, Studio wins", { kind: "conflict", base: st.synced, studio: source })
				this.notify("conflict", st.path, "Edited on both sides at once; Studio's version kept, disk version saved (cinq conflicts)", id)
				await this.writeRel(st.path, source)
				this.journal.edit("studio", id, st.path, st.synced, source, by)
				this.journal.event("disk", "conflict", st.path, { note: "edits to the same lines on both sides, Studio kept, see cinq conflicts" })
				st.synced = source
			}
		}
		this.dirty()
	}

	// A script whose CinqId changed (attribute removed, place reverted, script reinserted) is matched
	// to the tracked script it replaced by path, then by content, so its file and history carry over.
	relink(entries) {
		const ids = new Set(entries.map((e) => e.id))
		const vanished = [...this.scripts].filter(([id, st]) => !ids.has(id) && !this.inflight.has(id) && !st.pending)
		const relinked = []
		for (const entry of entries) {
			if (vanished.length === 0) break
			if (this.scripts.has(entry.id) || this.inflight.has(entry.id)) continue
			const rel = key(scriptPath(entry))
			let index = vanished.findIndex(([, st]) => key(st.path) === rel)
			if (index === -1 && entry.source !== undefined) index = vanished.findIndex(([, st]) => st.synced === entry.source)
			if (index === -1) continue
			const [oldId, st] = vanished.splice(index, 1)[0]
			this.scripts.delete(oldId)
			this.scripts.set(entry.id, st)
			relinked.push(entry)
			this.log.info(`relinked ${st.path} (CinqId ${oldId} → ${entry.id})`)
		}
		return relinked
	}

	async onTree(entries) {
		const relinked = this.relink(entries)
		const seen = new Set()
		const moves = []
		const adopt = []
		for (const entry of entries) {
			seen.add(entry.id)
			if (this.inflight.has(entry.id)) continue
			const rel = scriptPath(entry)
			const st = this.scripts.get(entry.id)
			if (st) {
				if (st.path !== rel) moves.push([entry.id, st, rel])
			} else if (entry.source !== undefined) {
				adopt.push([entry.id, rel, entry.source, this.editorOf(entry.source, entry)])
			}
		}
		for (const [id, st] of [...this.scripts]) {
			if (!seen.has(id) && !this.inflight.has(id) && !st.pending) await this.dropScript(id, st)
		}
		await this.applyMoves(moves)
		for (const [id, rel, source, by] of adopt) await this.adopt(id, rel, source, "studio", by)
		for (const entry of relinked) {
			if (entry.source !== undefined) await this.onStudioSource(entry.id, entry.source, this.editorOf(entry.source, entry))
		}
		this.dirty()
	}

	async adopt(id, rel, source, origin = "studio", by) {
		const disk = await this.readRel(rel)
		if (disk !== undefined && disk !== source) await this.backup(rel, disk, "Replaced untracked file")
		if (disk !== source) await this.writeRel(rel, source)
		else await this.recordStat(rel)
		this.scripts.set(id, { path: rel, synced: source })
		if (origin) this.journal.event(origin, "create", rel, { lines: source.split("\n").length, by })
		this.log.studio(`+ ${rel}`)
	}

	async dropScript(id, st, keepCopy = false) {
		const disk = await this.readRel(st.path)
		if (keepCopy && disk !== undefined) {
			await this.keepRemoved(st.path, disk)
		} else if (disk !== undefined && disk !== st.synced) {
			await this.backup(st.path, disk, "Script removed in Studio had unsynced disk edits", { kind: "removed", base: st.synced })
		}
		await this.removeRel(st.path)
		this.scripts.delete(id)
		this.journal.event(keepCopy ? "studio-offline" : "studio", "delete", st.path)
		this.log.studio(`- ${st.path}`)
	}

	async applyMoves(moves, origin = "studio") {
		if (moves.length === 0) return
		const tmpDir = path.join(this.metaDir, "tmp")
		await fsp.mkdir(tmpDir, { recursive: true })
		const staged = []
		for (const [id, st, rel] of moves) {
			const tmp = path.join(tmpDir, `${id}.luau`)
			let moved = true
			try {
				await fsp.rename(this.abs(st.path), tmp)
			} catch {
				moved = false
			}
			this.stats.delete(key(st.path))
			staged.push({ st, rel, tmp, moved, from: st.path })
		}
		for (const { st, rel, tmp, moved, from } of staged) {
			const existing = await this.readRel(rel)
			if (existing !== undefined) await this.backup(rel, existing, "Replaced untracked file")
			await fsp.mkdir(path.dirname(this.abs(rel)), { recursive: true })
			if (moved) await fsp.rename(tmp, this.abs(rel))
			else await fsp.writeFile(this.abs(rel), st.synced)
			await this.recordStat(rel)
			st.path = rel
			await this.prune(path.dirname(this.abs(from)))
			this.journal.event(origin, "move", rel, { from })
			this.log.studio(`${from} → ${rel}`)
		}
	}


	scheduleReconcile() {
		clearTimeout(this.reconcileTimer)
		this.reconcileTimer = setTimeout(() => this.run(() => this.reconcile()), WATCH_DEBOUNCE_MS)
	}

	startWatching() {
		try {
			this.watcher = fs.watch(this.dir, { recursive: true }, (_, file) => {
				if (String(file) === SOURCEMAP_FILE) return
				if (file && String(file).split(/[\\/]/).some((p) => p.startsWith("."))) return
				this.scheduleReconcile()
			})
		} catch (err) {
			this.log.warn(`File watching unavailable, falling back to polling: ${err.message}`)
		}
		this.interval = setInterval(() => this.scheduleReconcile(), FALLBACK_SCAN_MS)
	}

	async reconcile() {
		if (!this.ready || this.stopped) return
		const files = await this.walk()
		const missing = []
		const changed = []
		const caseRenames = []
		for (const [id, st] of this.scripts) {
			const k = key(st.path)
			const file = files.get(k)
			if (file) files.delete(k)
			if (this.inflight.has(id) || st.pending) continue
			if (!file) {
				missing.push(id)
				continue
			}
			if (file.rel !== st.path) caseRenames.push([id, file])
			if (this.stats.get(k) === file.sig) continue
			const text = await this.readRel(st.path)
			this.stats.set(k, file.sig)
			if (text !== undefined && text !== st.synced) changed.push([id, text])
		}

		const fresh = []
		for (const [k, file] of files) {
			if (this.rejected.get(k) === file.sig) continue
			const text = await this.readRel(file.rel)
			if (text !== undefined) fresh.push({ rel: file.rel, sig: file.sig, text })
		}

		const moves = []
		for (const id of [...missing]) {
			const st = this.scripts.get(id)
			const sameName = fresh.findIndex((f) => f.text === st.synced && baseName(f.rel) === baseName(st.path))
			const index = sameName !== -1 ? sameName : fresh.findIndex((f) => f.text === st.synced)
			if (index === -1) continue
			moves.push([id, fresh[index]])
			fresh.splice(index, 1)
			missing.splice(missing.indexOf(id), 1)
		}

		if (missing.length >= MASS_DELETE_MIN && missing.length > this.scripts.size * MASS_DELETE_RATIO) {
			this.log.warn(`${missing.length} files disappeared at once, restoring them instead of deleting the scripts in Studio`)
			for (const id of missing) await this.writeRel(this.scripts.get(id).path, this.scripts.get(id).synced)
			missing.length = 0
		}

		moves.push(...caseRenames)
		const parsedMoves = moves.map(([id, file]) => [id, file, parsePath(file.rel)])
		parsedMoves.sort((a, b) => (a[2] ? depth(a[2]) : 0) - (b[2] ? depth(b[2]) : 0))
		for (const [id, file, parsed] of parsedMoves) {
			const st = this.scripts.get(id)
			if (!parsed) {
				this.log.warn(`Can't map ${file.rel} to an instance, moving it back to ${st.path}`)
				await fsp.mkdir(path.dirname(this.abs(st.path)), { recursive: true })
				await fsp.rename(this.abs(file.rel), this.abs(st.path))
				await this.recordStat(st.path)
				continue
			}
			const from = st.path
			st.path = file.rel
			this.stats.set(key(file.rel), file.sig)
			this.send({ op: "move", id, from, path: file.rel, ...parsed })
			this.log.disk(`${from} → ${file.rel}`)
		}

		for (const [id, text] of changed) {
			const st = this.scripts.get(id)
			this.send({ op: "update", id, base: st.synced, source: text })
			this.log.disk(`→ ${st.path}`)
		}

		for (const id of missing) {
			this.send({ op: "delete", id })
			this.log.disk(`- ${this.scripts.get(id).path}`)
		}

		const creates = []
		for (const file of fresh) {
			const parsed = parsePath(file.rel)
			if (!parsed) {
				this.rejected.set(key(file.rel), file.sig)
				this.log.warn(`Ignoring ${file.rel}: it doesn't map to a script (init files need a parent folder, names need a .luau extension)`)
				continue
			}
			creates.push({ file, parsed })
		}
		creates.sort((a, b) => depth(a.parsed) - depth(b.parsed))
		for (const { file, parsed } of creates) {
			const id = newId()
			this.scripts.set(id, { path: file.rel, synced: file.text, pending: true })
			this.stats.set(key(file.rel), file.sig)
			this.send({ op: "create", id, path: file.rel, source: file.text, ...parsed })
			this.log.disk(`+ ${file.rel}`)
		}
		if (moves.length || changed.length || missing.length || creates.length) this.dirty()
	}

	async onApplied(ev) {
		const op = this.pending.get(ev.opId)
		if (!op) return
		this.pending.delete(ev.opId)
		if (this.inflight.get(op.id) === op.opId) this.inflight.delete(op.id)
		const st = this.scripts.get(op.id)
		if (!st) return

		if (op.op === "update") {
			if (ev.ok) {
				this.journal.edit("disk", op.id, st.path, st.synced, op.source)
				st.synced = op.source
			}
			else if (ev.source === undefined) {
				this.log.warn(`Studio rejected update to ${st.path}: ${ev.error}`)
				this.notify("problem", st.path, `Update rejected: ${ev.error}`, op.id)
			}
		} else if (op.op === "create") {
			if (ev.ok) {
				delete st.pending
				this.journal.event("disk", "create", op.path, { lines: op.source.split("\n").length })
			} else {
				this.scripts.delete(op.id)
				await this.recordStat(op.path)
				this.rejected.set(key(op.path), this.stats.get(key(op.path)))
				this.log.warn(`Studio couldn't create ${op.path}: ${ev.error}`)
				this.notify("problem", op.path, `Couldn't create it: ${ev.error}`)
			}
		} else if (op.op === "move") {
			if (!ev.ok) {
				this.log.warn(`Studio couldn't move ${op.from} → ${op.path} (${ev.error}), moving the file back`)
				this.notify("problem", op.from, `Move to ${op.path} refused, file put back: ${ev.error}`, op.id)
				try {
					await fsp.mkdir(path.dirname(this.abs(op.from)), { recursive: true })
					await fsp.rename(this.abs(op.path), this.abs(op.from))
				} catch {}
				await this.prune(path.dirname(this.abs(op.path)))
				this.stats.delete(key(op.path))
				st.path = op.from
				await this.recordStat(op.from)
			} else {
				this.journal.event("disk", "move", op.path, { from: op.from })
			}
		} else if (op.op === "delete") {
			if (ev.ok) {
				this.scripts.delete(op.id)
				this.journal.event("disk", "delete", st.path)
			} else {
				this.log.warn(`Studio couldn't delete ${st.path} (${ev.error}), restoring the file`)
				this.notify("problem", st.path, `Delete refused, file restored: ${ev.error}`, op.id)
				await this.writeRel(st.path, st.synced)
			}
		}
		if (ev.source !== undefined && this.scripts.has(op.id)) await this.onStudioSource(op.id, ev.source)
		this.dirty()
		this.scheduleReconcile()
	}

	async initialSync(entries) {
		const studio = new Map(entries.map((e) => [e.id, e]))
		const lost = []
		const adopt = []
		const offline = this.scripts.size > 0 ? "studio-offline" : null

		this.relink(entries)
		for (const [id, st] of [...this.scripts]) if (!studio.has(id)) await this.dropScript(id, st, true)

		for (const entry of entries) {
			const st = this.scripts.get(entry.id)
			const source = entry.source
			if (!st) {
				adopt.push(entry)
				continue
			}
			const disk = await this.readRel(st.path)
			if (disk === undefined) {
				lost.push(entry)
			} else if (disk === source) {
				st.synced = source
			} else if (disk === st.synced) {
				await this.writeRel(st.path, source)
				this.journal.change("studio-offline", entry.id, st.path, st.synced, source, this.editorOf(source, entry))
				st.synced = source
			} else if (source !== st.synced) {
				const merged = merge3(st.synced, disk, source)
				if (merged.clean) {
					await this.writeRel(st.path, merged.text)
					if (merged.text !== source) this.send({ op: "update", id: entry.id, base: source, source: merged.text })
					this.log.info(`merged offline edits in ${st.path}`)
				} else {
					await this.backup(st.path, disk, "Both sides changed while disconnected, Studio wins", { kind: "conflict", base: st.synced, studio: source })
					this.notify("conflict", st.path, "Changed on both sides while Cinq was off; Studio's version kept, disk version saved (cinq conflicts)", entry.id)
					await this.writeRel(st.path, source)
				}
				this.journal.change("studio-offline", entry.id, st.path, st.synced, source, this.editorOf(source, entry))
				st.synced = source
			}
			// Otherwise only the disk changed; the first reconcile pushes it to Studio.
		}

		if (lost.length > 0) {
			const tracked = new Set([...this.scripts.values()].map((st) => key(st.path)))
			const files = await this.walk()
			const unknown = []
			for (const [k, file] of files) {
				if (!tracked.has(k)) unknown.push({ rel: file.rel, text: await this.readRel(file.rel) })
			}
			for (const entry of lost) {
				const st = this.scripts.get(entry.id)
				const index = unknown.findIndex((f) => f.text === st.synced)
				const parsed = index === -1 ? null : parsePath(unknown[index].rel)
				if (parsed) {
					const file = unknown.splice(index, 1)[0]
					const from = st.path
					st.path = file.rel
					if (entry.source !== st.synced) {
						await this.writeRel(file.rel, entry.source)
						st.synced = entry.source
					}
					this.send({ op: "move", id: entry.id, from, path: file.rel, ...parsed })
					this.log.disk(`${from} → ${file.rel} (moved while disconnected)`)
				} else {
					await this.writeRel(st.path, entry.source)
					st.synced = entry.source
				}
			}
		}

		const moves = []
		for (const entry of entries) {
			const st = this.scripts.get(entry.id)
			const rel = scriptPath(entry)
			if (st && !this.inflight.has(entry.id) && st.path !== rel) moves.push([entry.id, st, rel])
		}
		await this.applyMoves(moves, "studio-offline")
		for (const entry of adopt) await this.adopt(entry.id, scriptPath(entry), entry.source, offline, this.editorOf(entry.source, entry))

		this.ready = true
		this.dirty()
		this.log.info(`Synced ${entries.length} scripts for "${this.placeName}" (${this.placeId}) → ${this.dir}`)
		await this.reconcile()
		this.startWatching()
	}
}

module.exports = { PlaceSync }
