"use strict"

const { listConflicts } = require("./conflicts")

const PORT = Number(process.env.CINQ_PORT ?? 34877)

async function main() {
	let health
	try {
		health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()
	} catch {
		console.log(`Cinq server: not running (nothing on port ${PORT})`)
		process.exit(1)
	}
	console.log(`Cinq server: running ${health.version} (pid ${health.pid}), syncing into ${health.placesDir ?? health.root}${health.awake ? `, keeping this computer awake until ${health.awake}` : ""}`)
	if (health.places.length === 0) {
		console.log("Studio: no places connected")
		process.exit(2)
	}
	for (const place of health.places) {
		const state = place.synced ? `${place.scripts} scripts synced` : "initial sync in progress"
		const open = listConflicts(place.dir).length
		const conflicts = open > 0 ? `, ${open} open conflict${open === 1 ? "" : "s"} (cinq conflicts)` : ""
		console.log(`Studio: "${place.placeName}" (${place.placeId}) connected, ${state}${conflicts}, last seen ${Math.round(place.lastSeenMs / 1000)}s ago → ${place.dir}`)
	}
}

if (require.main === module) main()

module.exports = { main }
