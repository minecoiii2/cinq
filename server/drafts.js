"use strict"

const fs = require("fs")
const path = require("path")
const { displayPath } = require("./check")
const { merge3, diffHunks } = require("./merge")
const { unifiedDiff } = require("./journal")

function changeStat(before, after) {
	let added = 0
	let removed = 0
	for (const h of diffHunks(before.split("\n"), after.split("\n"))) {
		added += h.b1 - h.b0
		removed += h.a1 - h.a0
	}
	return `+${added} −${removed}`
}

// The plugin knows a draft's base only if it saw the draft start.
function classify(draft) {
	if (typeof draft.base !== "string") return { kind: "unknown" }
	const merged = merge3(draft.base, draft.draft, draft.committed)
	if (!merged.clean) return { kind: "conflict" }
	if (merged.text === draft.draft) return { kind: "mine" }
	return { kind: "behind", merged: merged.text }
}

function describe(draft, status) {
	if (status.kind === "mine") return `your edits, ${changeStat(draft.committed, draft.draft)} lines vs committed`
	if (status.kind === "unknown") {
		const why = draft.tracked ? "this draft started before Cinq was watching" : "Cinq doesn't sync this script"
		return `differs from committed by ${changeStat(draft.committed, draft.draft)} lines; ${why}, so it can't tell your edits from a newer commit (View → Drafts shows Merge if there is one)`
	}
	const sides = `yours ${changeStat(draft.base, draft.draft)}, theirs ${changeStat(draft.base, draft.committed)}`
	return status.kind === "behind"
		? `someone committed since your draft started, merges cleanly (${sides}); --merge applies it`
		: `someone committed since your draft started and you both changed the same lines (${sides}); --diff shows both sides`
}

function printDiffs(draft, status) {
	if (status.kind === "mine" || status.kind === "unknown") {
		console.log("  your draft vs committed:")
		console.log(indent(unifiedDiff(draft.committed, draft.draft).diff))
		return
	}
	console.log("  yours (base → your draft):")
	console.log(indent(unifiedDiff(draft.base, draft.draft).diff))
	console.log("  theirs (base → committed):")
	console.log(indent(unifiedDiff(draft.base, draft.committed).diff))
}

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")
	} catch {
		return undefined
	}
}

const indent = (text) => text.split("\n").map((line) => `    ${line}`).join("\n")
const fileOf = (draft) => draft.file.replace(/^ → /, "")

async function main(args, { toolText, wait, editScript }) {
	// Studio's draft has to include every file edit first, since the merged text replaces the whole file.
	if (args.merge) await wait()
	const drafts = JSON.parse(await toolText("drafts", args, { within: args._[0] }, { raw: true }))
	if (drafts.length === 0) return console.log(args._[0] ? `No drafts under ${args._[0]}` : "No drafts: every script matches its committed version")

	const merged = []
	const needsHand = []
	const changedSince = []
	console.log(`${drafts.length} draft${drafts.length === 1 ? "" : "s"}:`)
	for (const draft of drafts) {
		const status = classify(draft)
		console.log(`${draft.path} [${draft.className}]${draft.file ? ` → ${displayPath(path.normalize(fileOf(draft)))}` : ""}`)
		console.log(`  ${describe(draft, status)}`)
		if (args.diff) printDiffs(draft, status)
		if (!args.merge) continue
		if (status.kind === "conflict") needsHand.push(draft.path)
		if (status.kind !== "behind") continue
		if (draft.file) {
			const onDisk = readText(fileOf(draft))
			if (onDisk !== draft.draft) {
				changedSince.push(draft.path)
				continue
			}
			fs.writeFileSync(fileOf(draft), status.merged)
		} else await editScript(draft.path, draft.draft, status.merged)
		merged.push(draft.path)
	}

	if (!args.merge) return
	if (merged.length > 0) {
		await wait()
		await toolText("drafts", args, { rebase: merged })
		console.log(`\nMerged into your draft: ${merged.join(", ")}. In View → Drafts, click Merge on ${merged.length === 1 ? "it" : "them"} (it now keeps both sides) and Commit.`)
	}
	if (needsHand.length > 0) console.log(`\nNeeds a hand merge, both sides changed the same lines: ${needsHand.join(", ")}`)
	if (changedSince.length > 0) console.log(`\nSkipped, the file changed after Studio's draft was read (run it again): ${changedSince.join(", ")}`)
	if (merged.length === 0 && needsHand.length === 0 && changedSince.length === 0) console.log("\nNothing to merge: no draft is behind a newer commit")
}

module.exports = { main, classify }
