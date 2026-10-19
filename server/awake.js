"use strict"

const { spawn } = require("child_process")

// Same mechanism as PowerToys Awake: a helper holds ES_SYSTEM_REQUIRED (sleep blocked, screen may still turn off)
// for as long as both the server and the owner process are alive, then exits and releases it.
function keepAwake(ownerPid) {
	const pids = [process.pid, ownerPid].filter(Boolean)
	let child
	if (process.platform === "win32") {
		const alive = pids.map((pid) => `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`).join(" -and ")
		const script = [
			`Add-Type -Name Power -Namespace Cinq -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
			// ES_CONTINUOUS | ES_SYSTEM_REQUIRED in decimal: PowerShell 5.1 reads 0x80000001 as a negative Int32.
			"[Cinq.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null",
			`while (${alive}) { Start-Sleep -Seconds 5 }`,
		].join("; ")
		child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true })
	} else if (process.platform === "darwin") {
		child = spawn("caffeinate", ["-i", "-w", String(ownerPid ?? process.pid)], { stdio: "ignore" })
	} else {
		return null
	}
	child.on("error", () => {})
	process.on("exit", () => child.kill())
	return child
}

module.exports = { keepAwake }
