"use strict"

const http = require("http")
const path = require("path")
const crypto = require("crypto")
const { PlaceSync } = require("./sync")
const { placesDir, placeKey: keyOf, readConfig, resolvePlaceDir, folderSize } = require("./places")
const { keepAwake } = require("./awake")
const { listConflicts } = require("./conflicts")
const log = require("./log")

const PORT = Number(process.env.CINQ_PORT ?? 34877)
const SESSION_TIMEOUT_MS = 25000
const TOOL_TIMEOUT_MS = 20000
const SUPERSEDED = "another Studio connected to the same place"
const VERSION = require("../package.json").version
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

// Browsers send Origin on cross-site POSTs (even "simple" text/plain ones that skip CORS), while Studio and the CLI don't.
// Checking Host too stops DNS rebinding, where a site's own domain is pointed at 127.0.0.1.
function isLocalRequest(headers) {
	if (headers.origin !== undefined) return false
	const host = (headers.host ?? "").replace(/:\d+$/, "").toLowerCase()
	return LOCAL_HOSTS.has(host)
}

function startServer(rootArg, { awake = true } = {}) {
	const places = placesDir(rootArg)
	let awakeHelper = null
	let awakeUntil = null

	function setAwake(owner) {
		const previous = awakeHelper
		awakeHelper = null
		awakeUntil = null
		previous?.kill()
		if (owner === false) return log.info("Stopped keeping this computer awake")
		const helper = keepAwake(owner?.pid)
		if (!helper) return log.warn("Keeping the computer awake isn't supported on this platform")
		awakeHelper = helper
		awakeUntil = owner?.label ?? "Cinq stops"
		helper.on("exit", () => {
			if (awakeHelper !== helper) return
			awakeHelper = null
			log.info(`Stopped keeping this computer awake (${awakeUntil.replace(/ closes$/, " closed").replace(/ stops$/, " stopped")})`)
			awakeUntil = null
		})
		log.info(`Keeping this computer awake until ${awakeUntil} (the screen can still turn off)`)
	}
	log.setFile(path.join(places, ".cinq", "server.log"))
	// A detached server has no console, so its log is the only place a crash shows up.
	process.on("uncaughtException", (err) => {
		log.error(`Cinq crashed: ${err.stack ?? err}`)
		process.exit(1)
	})
	process.on("unhandledRejection", (err) => log.error(`Unhandled error: ${err?.stack ?? err}`))
	const sessions = new Map()
	const byPlace = new Map()
	const superseded = new Set()

	function endSession(token, reason) {
		const sync = sessions.get(token)
		if (!sync) return
		sessions.delete(token)
		if (reason === SUPERSEDED) superseded.add(token)
		if (byPlace.get(sync.placeKey) === token) byPlace.delete(sync.placeKey)
		sync.stop()
		log.info(`${sync.placeName} (${sync.placeId}) disconnected: ${reason}`)
	}

	function pickSession(place) {
		const all = [...sessions.values()]
		if (all.length === 0) throw new Error("No Studio is connected to Cinq")
		if (!place) {
			if (all.length === 1) return all[0]
			throw new Error(`Several Studios are connected, pick one with --place: ${all.map((s) => `"${s.placeName}" (${s.placeId})`).join(", ")}`)
		}
		const wanted = String(place).toLowerCase()
		const names = (s) => [s.placeId, s.placeName.toLowerCase(), path.basename(s.dir).toLowerCase()]
		const exact = all.filter((s) => names(s).includes(wanted))
		const matches = exact.length > 0 ? exact : all.filter((s) => names(s).some((n) => n.includes(wanted)))
		if (matches.length === 1) return matches[0]
		if (matches.length === 0) throw new Error(`No connected Studio matches "${place}"`)
		throw new Error(`"${place}" matches several Studios, nothing was run. Use more of the name or the PlaceId: ${matches.map((s) => `"${s.placeName}" (${s.placeId})`).join(", ")}`)
	}

	const routes = {
		"GET /health": async () => ({
			name: "cinq",
			version: VERSION,
			placesDir: places,
			pid: process.pid,
			awake: awakeUntil,
			places: [...sessions.values()].map((sync) => ({
				placeId: sync.placeId,
				placeName: sync.placeName,
				dir: sync.dir,
				synced: sync.ready,
				scripts: sync.scripts.size,
				connectedAt: new Date(sync.connectedAt).toISOString(),
				lastSeenMs: Date.now() - sync.lastSeen,
			})),
		}),

		"POST /connect": async (body) => {
			const placeId = String(body.placeId ?? 0)
			const placeName = String(body.placeName ?? "Untitled")
			const placeKey = keyOf(placeId, placeName)
			const previous = byPlace.get(placeKey)
			if (previous) endSession(previous, SUPERSEDED)
			const sync = new PlaceSync(resolvePlaceDir(places, placeId, placeName, { rename: true, links: readConfig().links }), placeId, placeName)
			sync.placeKey = placeKey
			await sync.load()
			const token = crypto.randomBytes(12).toString("hex")
			sessions.set(token, sync)
			byPlace.set(placeKey, token)
			log.info(`${placeName} (${placeId}) connected`)
			return { session: token, dir: sync.dir, version: VERSION }
		},

		"GET /size": async (_, __, query) => {
			const dir = resolvePlaceDir(places, String(query.get("placeId") ?? 0), String(query.get("placeName") ?? "Untitled"), { links: readConfig().links })
			return { dir, ...(await folderSize(dir)), conflicts: listConflicts(dir).length }
		},

		"POST /events": async (body, sync) => {
			sync.handleEvents(body.events ?? [])
			return { ok: true }
		},

		"GET /poll": async (_, sync, query) => ({ ops: await sync.poll(Number(query.get("after") ?? 0)) }),

		"POST /tool": async (body) => {
			let sync
			try {
				sync = pickSession(body.place)
			} catch (err) {
				return { ok: false, error: err.message }
			}
			const timeout = Math.min(Number(body.timeout ?? TOOL_TIMEOUT_MS / 1000), 300) * 1000
			return { place: sync.placeName, ...(await sync.requestTool(body.tool, body.args ?? {}, timeout)) }
		},

		"POST /wait": async (body) => {
			let targets
			try {
				targets = body.place ? [pickSession(body.place)] : [...sessions.values()]
			} catch (err) {
				return { ok: false, error: err.message }
			}
			if (targets.length === 0) return { ok: false, error: "No Studio is connected to Cinq" }
			const timeout = Math.min(Number(body.timeout ?? 15), 120) * 1000
			const places = await Promise.all(
				targets.map(async (sync) => {
					const flushed = await sync.requestTool("flush", {}, Math.min(timeout, 8000))
					return { place: sync.placeName, flushed: flushed.ok, ...(await sync.waitSettled(timeout)) }
				})
			)
			return { ok: places.every((p) => p.settled), places }
		},

		"POST /sourcemap": async (body) => {
			try {
				const sync = pickSession(body.place)
				return { ok: true, place: sync.placeName, ...(await sync.writeSourcemap()) }
			} catch (err) {
				return { ok: false, error: err.message }
			}
		},

		"POST /tool/result": async (body, sync) => {
			sync.resolveTool(body.requestId, { ok: body.ok === true, text: body.text, error: body.error })
			return { ok: true }
		},

		"POST /journal/flush": async () => {
			for (const sync of sessions.values()) sync.journal.flush()
			return { ok: true }
		},

		"POST /awake": async (body) => {
			setAwake(body.enabled === false ? false : body.owner ?? null)
			return { ok: true, awake: awakeUntil }
		},

		"POST /shutdown": async () => {
			setTimeout(shutdown, 50)
			return { ok: true }
		},

		"POST /disconnect": async (body) => {
			endSession(body.session, "plugin disconnected")
			return { ok: true }
		},
	}

	const needsSession = new Set(["/events", "/poll", "/tool/result"])

	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = []
			req.on("data", (chunk) => chunks.push(chunk))
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
			req.on("error", reject)
		})
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://localhost")
		const route = routes[`${req.method} ${url.pathname}`]
		const reply = (status, payload) => {
			res.writeHead(status, { "Content-Type": "application/json" })
			res.end(JSON.stringify(payload))
		}
		if (!isLocalRequest(req.headers)) {
			log.warn(`Refused ${req.method} ${url.pathname} from ${req.headers.origin ?? req.headers.host}: only Studio and the cinq CLI may use the server`)
			return reply(403, { error: "forbidden" })
		}
		if (!route) return reply(404, { error: "not found" })
		try {
			const raw = req.method === "POST" ? await readBody(req) : ""
			const body = raw ? JSON.parse(raw) : {}
			const token = body.session ?? url.searchParams.get("session")
			const sync = needsSession.has(url.pathname) ? sessions.get(token) : undefined
			if (needsSession.has(url.pathname) && !sync) return reply(409, { error: superseded.has(token) ? "superseded" : "session ended" })
			reply(200, await route(body, sync, url.searchParams))
		} catch (err) {
			log.error(err.stack ?? String(err))
			reply(500, { error: String(err.message ?? err) })
		}
	})

	setInterval(() => {
		for (const [token, sync] of sessions) {
			if (Date.now() - sync.lastSeen > SESSION_TIMEOUT_MS) endSession(token, "timed out")
		}
	}, 5000).unref()

	function shutdown() {
		for (const token of [...sessions.keys()]) endSession(token, "server stopped")
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)

	server.on("error", async (err) => {
		if (err.code !== "EADDRINUSE") {
			log.error(err.message)
			process.exit(1)
		}
		try {
			const running = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()
			if (running.name !== "cinq") throw new Error()
			log.info(`Cinq ${running.version} is already running and syncing every Studio into ${running.placesDir ?? running.root}. This window can be closed.`)
			process.exit(0)
		} catch {
			log.error(`Port ${PORT} is used by another program. Set CINQ_PORT to run Cinq on a different port.`)
			process.exit(1)
		}
	})

	server.listen(PORT, "127.0.0.1", () => {
		log.info(`Cinq ${VERSION} listening on http://localhost:${PORT}`)
		log.info(`Places sync into ${places}`)
		if (awake) setAwake(null)
	})
}

if (require.main === module) startServer(process.argv[2])

module.exports = { startServer, isLocalRequest, PORT }
