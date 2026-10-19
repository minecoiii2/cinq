"use strict"

const SERVICES = ["ReplicatedStorage", "ReplicatedFirst", "ServerScriptService", "ServerStorage", "StarterPlayer", "StarterGui", "StarterPack", "Lighting", "SoundService"]
const KINDS = ["server", "client", "local", "legacy", "plugin"]
const EXT = ".luau"
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

const hex = (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")
const encodeAt = (s, i) => s.slice(0, i) + hex(s[i]) + s.slice(i + 1)

function encodeName(name) {
	if (name === "") return "%"
	let out = name.replace(/[%<>:"/\\|?*~\x00-\x1f\x7f]/g, hex)
	if (out.startsWith(".")) out = encodeAt(out, 0)
	if (out.endsWith(".") || out.endsWith(" ")) out = encodeAt(out, out.length - 1)
	const stem = out.split(".")[0]
	if (RESERVED.test(stem) || out.toLowerCase() === "init") out = encodeAt(out, 0)
	const lower = out.toLowerCase()
	// A module named "Foo.server" would otherwise read back as a server Script named "Foo".
	for (const kind of KINDS) {
		if (lower.endsWith("." + kind)) out = encodeAt(out, out.length - kind.length - 1)
	}
	return out
}

function decodeName(encoded) {
	if (encoded === "%") return ""
	return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

const segmentName = (seg) => encodeName(seg.name) + (seg.id ? "~" + seg.id : "")

function parseSegment(raw) {
	const at = raw.lastIndexOf("~")
	if (at === -1) return { name: decodeName(raw) }
	return { name: decodeName(raw.slice(0, at)), id: raw.slice(at + 1) }
}

const extFor = (kind) => (kind === "module" ? EXT : "." + kind + EXT)

function scriptPath(entry) {
	const segs = entry.segments
	const dirs = [segs[0].name, ...segs.slice(1, -1).map(segmentName)]
	const last = segmentName(segs[segs.length - 1])
	return entry.isDir ? [...dirs, last, "init" + extFor(entry.kind)].join("/") : [...dirs, last + extFor(entry.kind)].join("/")
}

function parsePath(rel) {
	const parts = rel.split(/[\\/]/)
	if (parts.length < 2 || !SERVICES.includes(parts[0])) return null
	if (parts.some((p) => p === "" || p.startsWith("."))) return null
	const file = parts[parts.length - 1]
	if (!file.toLowerCase().endsWith(EXT)) return null
	let stem = file.slice(0, -EXT.length)
	let kind = "module"
	for (const k of KINDS) {
		if (stem.toLowerCase().endsWith("." + k)) {
			kind = k
			stem = stem.slice(0, -(k.length + 1))
			break
		}
	}
	if (stem === "") return null
	const isDir = stem.toLowerCase() === "init"
	const names = isDir ? parts.slice(1, -1) : [...parts.slice(1, -1), stem]
	if (names.length === 0) return null
	return { segments: [{ name: parts[0] }, ...names.map(parseSegment)], kind, isDir }
}

module.exports = { SERVICES, encodeName, decodeName, scriptPath, parsePath }
