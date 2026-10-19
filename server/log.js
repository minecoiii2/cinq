"use strict"

const fs = require("fs")
const path = require("path")

const MAX_LOG_BYTES = 2 * 1024 * 1024
const KINDS = ["info", "studio", "disk", "warn", "error"]

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = color(90)
const tint = { info: color(36), studio: color(35), disk: color(32), warn: color(33), error: color(31) }

let logFile = null

function setFile(file) {
	logFile = file
	fs.mkdirSync(path.dirname(file), { recursive: true })
}

function writeFile(text) {
	if (!logFile) return
	try {
		if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, logFile.replace(/\.log$/, ".old.log"))
		fs.appendFileSync(logFile, text + "\n")
	} catch {}
}

function line(kind, message, place) {
	const time = new Date().toTimeString().slice(0, 8)
	const tagged = place ? `[${place}] ${message}` : message
	const out = `${dim(time)} ${tint[kind](kind.padEnd(6))} ${tagged}`
	if (kind === "error") console.error(out)
	else console.log(out)
	writeFile(`${new Date().toISOString().slice(0, 10)} ${time} ${kind.padEnd(6)} ${tagged}`)
}

function forPlace(place) {
	return Object.fromEntries(KINDS.map((kind) => [kind, (m) => line(kind, m, place)]))
}

module.exports = { ...forPlace(null), forPlace, setFile }
