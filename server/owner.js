"use strict"

const { execFileSync } = require("child_process")

// On Windows sh.exe is only npm's short-lived launcher for Git Bash, never the terminal itself.
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "zsh", "fish", "nu", ...(process.platform === "win32" ? [] : ["sh"])])

function processTable() {
	if (process.platform === "win32") {
		const csv = execFileSync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"],
			{ encoding: "utf8", windowsHide: true }
		)
		return new Map(
			csv
				.trim()
				.split(/\r?\n/)
				.slice(1)
				.map((line) => {
					const [pid, ppid, name] = line.replace(/"/g, "").split(",")
					return [Number(pid), { ppid: Number(ppid), name }]
				})
		)
	}
	const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
	return new Map(
		out
			.trim()
			.split("\n")
			.map((line) => {
				const [pid, ppid, ...name] = line.trim().split(/\s+/)
				return [Number(pid), { ppid: Number(ppid), name: name.join(" ").split("/").pop() }]
			})
	)
}

// The process whose closing should end the awake lock: the Claude app if Claude launched us,
// otherwise the outermost shell (the terminal tab), skipping short-lived launcher shells in between.
function findOwner() {
	let table
	try {
		table = processTable()
	} catch {
		return null
	}
	const ancestors = (start) => {
		const chain = []
		let pid = start
		while (pid && table.has(pid) && chain.length < 30) {
			const { ppid, name } = table.get(pid)
			chain.push({ pid, name, base: name.toLowerCase().replace(/\.exe$/, "") })
			pid = ppid
		}
		return chain
	}
	const chain = ancestors(table.get(process.pid)?.ppid)
	// Git Bash launchers break the parent chain, so fall back to the pid Claude Code exports to its shells.
	const fromClaude = process.env.CLAUDE_PID ? ancestors(Number(process.env.CLAUDE_PID)) : []
	const claude = [...chain, ...fromClaude].filter((p) => p.base === "claude")
	if (claude.length > 0) return { pid: claude.at(-1).pid, label: "Claude closes" }
	const shells = chain.filter((p) => SHELLS.has(p.base))
	if (shells.length > 0) return { pid: shells.at(-1).pid, label: `this terminal (${shells.at(-1).name}) closes` }
	return null
}

module.exports = { findOwner }
