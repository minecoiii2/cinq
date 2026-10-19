"use strict"

const MAX_EDIT_DISTANCE = 4000

function myersMatches(a, b) {
	const n = a.length
	const m = b.length
	if (n === 0 || m === 0) return []
	const max = Math.min(n + m, MAX_EDIT_DISTANCE)
	const off = max + 1
	const v = new Int32Array(2 * max + 3)
	const trace = []
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice(off - d - 1, off + d + 2))
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
			let y = x - k
			while (x < n && y < m && a[x] === b[y]) {
				x++
				y++
			}
			v[off + k] = x
			if (x >= n && y >= m) return backtrack(trace, n, m)
		}
	}
	return null
}

function backtrack(trace, n, m) {
	const matches = []
	let x = n
	let y = m
	for (let d = trace.length - 1; d >= 0; d--) {
		const row = trace[d]
		const at = (k) => row[k + d + 1]
		const k = x - y
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
		const prevX = at(prevK)
		const prevY = prevX - prevK
		while (x > prevX && y > prevY) {
			x--
			y--
			matches.push([x, y])
		}
		x = prevX
		y = prevY
	}
	return matches.reverse()
}

// Regions where a[a0..a1) was replaced by b[b0..b1).
function diffHunks(a, b) {
	let pre = 0
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
	let suf = 0
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
	const midA = a.slice(pre, a.length - suf)
	const midB = b.slice(pre, b.length - suf)
	if (midA.length === 0 && midB.length === 0) return []
	const matches = myersMatches(midA, midB) ?? []
	const hunks = []
	let i = 0
	let j = 0
	for (const [mi, mj] of [...matches, [midA.length, midB.length]]) {
		if (mi > i || mj > j) hunks.push({ a0: i + pre, a1: mi + pre, b0: j + pre, b1: mj + pre })
		i = mi + 1
		j = mj + 1
	}
	return hunks
}

function sideVersion(base, lines, hunks, start, end) {
	const out = []
	let p = start
	for (const h of hunks) {
		out.push(...base.slice(p, h.a0), ...lines.slice(h.b0, h.b1))
		p = h.a1
	}
	out.push(...base.slice(p, end))
	return out
}

function merge3(baseText, oursText, theirsText) {
	if (oursText === theirsText || theirsText === baseText) return { clean: true, text: oursText }
	if (oursText === baseText) return { clean: true, text: theirsText }
	const base = baseText.split("\n")
	const sides = [oursText.split("\n"), theirsText.split("\n")]
	const all = [
		...diffHunks(base, sides[0]).map((h) => ({ ...h, side: 0 })),
		...diffHunks(base, sides[1]).map((h) => ({ ...h, side: 1 })),
	].sort((x, y) => x.a0 - y.a0 || x.side - y.side)

	const out = []
	let pos = 0
	let i = 0
	while (i < all.length) {
		const group = [all[i]]
		let start = all[i].a0
		let end = all[i].a1
		i++
		// Edits touching at the same base line (or inserting there) are treated as overlapping.
		while (i < all.length && (all[i].a0 < end || (all[i].a0 === end && (all[i].a0 === all[i].a1 || group.some((g) => g.a0 === g.a1 && g.a0 === end))))) {
			end = Math.max(end, all[i].a1)
			group.push(all[i])
			i++
		}
		out.push(...base.slice(pos, start))
		const versions = [0, 1].map((side) => {
			const hunks = group.filter((g) => g.side === side)
			return hunks.length === 0 ? null : sideVersion(base, sides[side], hunks, start, end)
		})
		if (versions[0] && versions[1] && versions[0].join("\n") !== versions[1].join("\n")) return { clean: false }
		out.push(...(versions[0] ?? versions[1]))
		pos = end
	}
	out.push(...base.slice(pos))
	return { clean: true, text: out.join("\n") }
}

module.exports = { merge3, diffHunks }
