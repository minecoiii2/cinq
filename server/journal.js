"use strict"

const fs = require("fs")
const path = require("path")
const { diffHunks } = require("./merge")

const IDLE_FLUSH_MS = 5 * 60 * 1000
const MAX_OPEN_MS = 30 * 60 * 1000
const MAX_DIFF_LINES = 300
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024
const CONTEXT = 2

function unifiedDiff(before, after) {
	const a = before.split("\n")
	const b = after.split("\n")
	const hunks = diffHunks(a, b)
	const groups = []
	for (const hunk of hunks) {
		const last = groups.at(-1)
		if (last && hunk.a0 - last.at(-1).a1 <= CONTEXT * 2) last.push(hunk)
		else groups.push([hunk])
	}
	const out = []
	let added = 0
	let removed = 0
	for (const group of groups) {
		const start = Math.max(0, group[0].a0 - CONTEXT)
		const end = Math.min(a.length, group.at(-1).a1 + CONTEXT)
		const bStart = group[0].b0 - (group[0].a0 - start)
		const body = []
		let pos = start
		for (const h of group) {
			for (const line of a.slice(pos, h.a0)) body.push(" " + line)
			for (const line of a.slice(h.a0, h.a1)) body.push("-" + line)
			for (const line of b.slice(h.b0, h.b1)) body.push("+" + line)
			removed += h.a1 - h.a0
			added += h.b1 - h.b0
			pos = h.a1
		}
		for (const line of a.slice(pos, end)) body.push(" " + line)
		const bLength = body.filter((l) => l[0] !== "-").length
		out.push(`@@ -${start + 1},${end - start} +${bStart + 1},${bLength} @@`, ...body)
	}
	const truncated = out.length > MAX_DIFF_LINES
	return { diff: (truncated ? [...out.slice(0, MAX_DIFF_LINES), "… diff truncated"] : out).join("\n"), added, removed }
}

// Bursts of edits to one script from one side become a single entry once they go quiet.
class Journal {
	constructor(file) {
		this.file = file
		this.open = new Map()
	}

	append(entry) {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true })
			if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_JOURNAL_BYTES) {
				fs.renameSync(this.file, this.file.replace(/\.jsonl$/, ".old.jsonl"))
			}
			fs.appendFileSync(this.file, JSON.stringify(entry) + "\n")
		} catch {}
	}

	edit(origin, id, rel, before, after, by) {
		const key = `${origin}|${id}`
		if (this.open.has(key) && this.open.get(key).by !== by) this.close(key)
		const open = this.open.get(key)
		if (open) {
			open.after = after
			open.path = rel
			open.end = new Date().toISOString()
			clearTimeout(open.timer)
			if (Date.now() - open.started > MAX_OPEN_MS) return this.close(key)
			open.timer = setTimeout(() => this.close(key), IDLE_FLUSH_MS).unref()
			return
		}
		const now = new Date().toISOString()
		const entry = { origin, id, path: rel, before, after, by, start: now, end: now, started: Date.now() }
		entry.timer = setTimeout(() => this.close(key), IDLE_FLUSH_MS).unref()
		this.open.set(key, entry)
	}

	change(origin, id, rel, before, after, by) {
		this.edit(origin, id, rel, before, after, by)
		this.close(`${origin}|${id}`)
	}

	close(key) {
		const entry = this.open.get(key)
		if (!entry) return
		this.open.delete(key)
		clearTimeout(entry.timer)
		if (entry.before.replace(/\r/g, "") === entry.after.replace(/\r/g, "")) return
		const { diff, added, removed } = unifiedDiff(entry.before, entry.after)
		this.append({ time: entry.start, end: entry.end, origin: entry.origin, by: entry.by, kind: "edit", path: entry.path, added, removed, diff })
	}

	event(origin, kind, rel, extra = {}) {
		for (const key of [...this.open.keys()]) if (this.open.get(key).path === rel) this.close(key)
		this.append({ time: new Date().toISOString(), origin, kind, path: rel, ...extra })
	}

	flush() {
		for (const key of [...this.open.keys()]) this.close(key)
	}
}

module.exports = { Journal, unifiedDiff }
