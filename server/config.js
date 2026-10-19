"use strict"

const fs = require("fs")
const path = require("path")
const { SERVICES } = require("./paths")
const { SOURCEMAP_FILE } = require("./sourcemap")
const { CONFIG_FILE, DEFAULT_PLACES_DIR, readConfig, writeConfig, placesDir, placeKey, resolvePlaceDir } = require("./places")

// The files Cinq writes into a place's folder; everything else in a linked folder belongs to the user.
const PLACE_ENTRIES = [...SERVICES, ".cinq", SOURCEMAP_FILE]

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (child, parent) => {
	const rel = path.relative(path.resolve(parent), path.resolve(child))
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}
const entriesOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])

function fail(message) {
	console.error(message)
	process.exit(1)
}

function move(from, to) {
	fs.mkdirSync(path.dirname(to), { recursive: true })
	try {
		fs.renameSync(from, to)
	} catch (err) {
		if (err.code !== "EXDEV") throw err
		fs.cpSync(from, to, { recursive: true })
		fs.rmSync(from, { recursive: true, force: true })
	}
}

function removeIfEmpty(dir) {
	try {
		if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
	} catch {}
}

// Moving folders under a running server would confuse it, so it's stopped first and started again after.
async function withServerStopped(cli, work) {
	const wasRunning = Boolean(await cli.health())
	if (wasRunning) await cli.commands.stop()
	try {
		work()
	} finally {
		if (wasRunning) await cli.commands.start({ _: [] }, [])
	}
}

function show() {
	const config = readConfig()
	console.log(`Places folder: ${placesDir()}${config.root ? "" : " (the default)"}`)
	const links = Object.entries(config.links)
	if (links.length === 0) console.log("Linked places: none (cinq link <place> <folder> gives one place its own folder)")
	else {
		console.log("Linked places:")
		for (const [key, dir] of links) console.log(`  ${key} → ${dir}${fs.existsSync(dir) ? "" : " (folder doesn't exist yet)"}`)
	}
	console.log(`Config file: ${CONFIG_FILE}`)
}

async function setRoot(args, cli) {
	const reset = args.reset === true
	if (!reset && !args._[1]) fail("Usage: cinq config root <folder> | cinq config root --reset")
	const config = readConfig()
	const current = placesDir()
	const target = reset ? DEFAULT_PLACES_DIR : path.resolve(args._[1])
	if (same(current, target)) return console.log(`Places already sync into ${target}`)
	if (inside(target, current) || inside(current, target)) fail(`${target} can't be inside the current places folder ${current}, or the other way around`)
	const moving = entriesOf(current)
	const clashes = moving.filter((name) => fs.existsSync(path.join(target, name)))
	if (clashes.length > 0) fail(`${target} already has ${clashes.join(", ")}, nothing was moved. Pick an empty folder.`)

	await withServerStopped(cli, () => {
		for (const name of moving) move(path.join(current, name), path.join(target, name))
		removeIfEmpty(current)
		writeConfig({ ...config, root: reset ? null : target })
	})
	console.log(`Places sync into ${target} now${moving.length > 0 ? `; moved ${moving.length} item${moving.length === 1 ? "" : "s"} from ${current}` : ""}`)
}

async function link(args, cli) {
	const [wanted, folder] = args._
	if (!wanted || !folder) fail("Usage: cinq link <place> <folder>  (the place by PlaceId or name; a PlaceId that hasn't synced yet works too)")
	const config = readConfig()
	const base = placesDir()
	const target = path.resolve(folder)
	const known = cli.listPlaces(base)
	const place = /^\d+$/.test(wanted) && !known.some((p) => p.placeId === wanted) ? null : cli.matchPlace(known, wanted)
	const key = place ? place.linked || placeKey(place.placeId, place.placeName) : wanted

	if (place && same(place.dir, target)) return console.log(`${place.label} already syncs into ${target}`)
	const owner = Object.entries(config.links).find(([other, dir]) => other !== key && same(dir, target))
	if (owner) fail(`${target} is already linked to ${owner[0]}`)
	if (same(target, base) || inside(target, base)) fail(`Pick a folder outside the places folder (${base})`)
	const existing = SERVICES.filter((service) => fs.existsSync(path.join(target, service)))
	if (existing.length > 0) fail(`${target} already has ${existing.join(", ")}. Cinq would merge those into Studio on connect, so nothing was done. Pick a folder without them.`)
	const moving = place ? PLACE_ENTRIES.filter((name) => fs.existsSync(path.join(place.dir, name))) : []
	const clashes = moving.filter((name) => fs.existsSync(path.join(target, name)))
	if (clashes.length > 0) fail(`${target} already has ${clashes.join(", ")}, nothing was moved`)

	await withServerStopped(cli, () => {
		fs.mkdirSync(target, { recursive: true })
		for (const name of moving) move(path.join(place.dir, name), path.join(target, name))
		if (place && !place.linked) {
			fs.rmSync(path.join(place.dir, ".vscode"), { recursive: true, force: true })
			removeIfEmpty(place.dir)
		}
		writeConfig({ ...config, links: { ...config.links, [key]: target } })
	})
	console.log(`${place ? place.label : `Place ${key}`} syncs into ${target} now${moving.length > 0 ? " (its files and history moved with it)" : ""}.`)
	console.log("If that folder is in a git repo, add .cinq/ (Cinq's state and journal) and sourcemap.json to its .gitignore.")
}

async function unlink(args, cli) {
	const config = readConfig()
	const base = placesDir()
	const wanted = args._[0]
	if (!wanted) fail("Usage: cinq unlink <place> [--keep]  (--keep leaves the files where they are)")
	const linkedPlaces = cli.listPlaces(base).filter((p) => p.linked)
	const place = config.links[wanted] && !linkedPlaces.some((p) => p.linked === wanted) ? null : cli.matchPlace(linkedPlaces, wanted)
	const key = place ? place.linked : wanted
	if (!config.links[key]) fail(`${wanted} isn't linked (cinq config lists the links)`)
	const { [key]: from, ...links } = config.links
	const placeId = key.startsWith("0:") ? "0" : key
	const dest = resolvePlaceDir(base, placeId, key.startsWith("0:") ? key.slice(2) : place?.placeName ?? key)
	const moving = args.keep || !fs.existsSync(from) ? [] : PLACE_ENTRIES.filter((name) => fs.existsSync(path.join(from, name)))
	const clashes = moving.filter((name) => fs.existsSync(path.join(dest, name)))
	if (clashes.length > 0) fail(`${dest} already has ${clashes.join(", ")}, nothing was moved`)

	await withServerStopped(cli, () => {
		for (const name of moving) move(path.join(from, name), path.join(dest, name))
		writeConfig({ ...config, links })
	})
	console.log(args.keep ? `Unlinked ${key}; its files stay in ${from}, and it syncs into ${dest} from now on` : `Moved ${key} back to ${dest}`)
}

module.exports = { show, setRoot, link, unlink }
