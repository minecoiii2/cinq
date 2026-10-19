"use strict"

// Roblox binary model writer for string and enum properties; chunks are stored uncompressed, which Studio accepts.

const TYPE_STRING = 0x01
const TYPE_ENUM = 0x12

const u32 = (n) => {
	const b = Buffer.alloc(4)
	b.writeUInt32LE(n >>> 0)
	return b
}
const str = (s) => {
	const bytes = Buffer.from(s, "utf8")
	return Buffer.concat([u32(bytes.length), bytes])
}

function interleave(words) {
	const out = Buffer.alloc(words.length * 4)
	words.forEach((word, j) => {
		for (let i = 0; i < 4; i++) out[i * words.length + j] = word[i]
	})
	return out
}

const bigEndian = (n) => {
	const b = Buffer.alloc(4)
	b.writeUInt32BE(n >>> 0)
	return b
}
const i32Array = (values) => interleave(values.map((v) => bigEndian((v << 1) ^ (v >> 31))))
const u32Array = (values) => interleave(values.map(bigEndian))
const referents = (refs) => i32Array(refs.map((r, i) => (i === 0 ? r : r - refs[i - 1])))

const chunk = (name, data) => Buffer.concat([Buffer.from(name, "latin1"), u32(0), u32(data.length), u32(0), data])

function writeRbxm(roots) {
	const instances = []
	const visit = (node, parent) => {
		const ref = instances.length
		instances.push({ node, ref, parent })
		for (const child of node.children ?? []) visit(child, ref)
	}
	for (const root of roots) visit(root, -1)

	const classes = new Map()
	for (const inst of instances) {
		if (!classes.has(inst.node.className)) classes.set(inst.node.className, [])
		classes.get(inst.node.className).push(inst)
	}

	const chunks = []
	let classId = 0
	const props = []
	for (const [className, members] of classes) {
		chunks.push(chunk("INST", Buffer.concat([u32(classId), str(className), Buffer.from([0]), u32(members.length), referents(members.map((m) => m.ref))])))
		const names = new Set(members.flatMap((m) => Object.keys(m.node.properties)))
		for (const name of names) {
			const values = members.map((m) => m.node.properties[name])
			const type = values.find(Boolean).type
			const header = Buffer.concat([u32(classId), str(name)])
			if (type === "string") {
				props.push(chunk("PROP", Buffer.concat([header, Buffer.from([TYPE_STRING]), ...values.map((v) => str(v?.value ?? ""))])))
			} else if (type === "enum") {
				props.push(chunk("PROP", Buffer.concat([header, Buffer.from([TYPE_ENUM]), u32Array(values.map((v) => v?.value ?? 0))])))
			} else {
				throw new Error(`Unsupported property type ${type}`)
			}
		}
		classId++
	}
	chunks.push(...props)
	chunks.push(chunk("PRNT", Buffer.concat([Buffer.from([0]), u32(instances.length), referents(instances.map((i) => i.ref)), referents(instances.map((i) => i.parent))])))
	chunks.push(chunk("END\0", Buffer.from("</roblox>", "latin1")))

	const header = Buffer.concat([
		Buffer.from("<roblox!", "latin1"),
		Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.from([0, 0]),
		u32(classes.size),
		u32(instances.length),
		Buffer.alloc(8),
	])
	return Buffer.concat([header, ...chunks])
}

module.exports = { writeRbxm }
