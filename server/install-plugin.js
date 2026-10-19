"use strict"

const fs = require("fs")
const path = require("path")
const { writeRbxm } = require("./rbxm")

const RUN_CONTEXT = { legacy: 0, server: 1, client: 2, plugin: 3 }
const source = path.join(__dirname, "..", "plugin")
const dist = path.join(__dirname, "..", "dist", "Cinq.rbxm")
const pluginsDir = path.join(process.env.LOCALAPPDATA ?? "", "Roblox", "Plugins")

function parseFile(file) {
	const stem = file.replace(/\.luau$/i, "")
	const match = stem.match(/^(.*)\.(server|client|local|legacy|plugin)$/)
	return match ? { name: match[1], kind: match[2] } : { name: stem, kind: "module" }
}

function scriptNode(name, kind, text, children = []) {
	const className = kind === "module" ? "ModuleScript" : kind === "local" ? "LocalScript" : "Script"
	const properties = { Name: { type: "string", value: name }, Source: { type: "string", value: text } }
	if (className === "Script") properties.RunContext = { type: "enum", value: RUN_CONTEXT[kind] }
	return { className, properties, children }
}

function dirNode(dir, name) {
	const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."))
	const init = entries.find((e) => e.isFile() && /^init(\.[a-z]+)?\.luau$/i.test(e.name))
	const children = entries
		.filter((e) => e !== init && (e.isDirectory() || e.name.toLowerCase().endsWith(".luau")))
		.map((e) => {
			const full = path.join(dir, e.name)
			if (e.isDirectory()) return dirNode(full, e.name)
			const { name: childName, kind } = parseFile(e.name)
			return scriptNode(childName, kind, fs.readFileSync(full, "utf8"))
		})
	if (!init) return { className: "Folder", properties: { Name: { type: "string", value: name } }, children }
	return scriptNode(name, parseFile(init.name).kind, fs.readFileSync(path.join(dir, init.name), "utf8"), children)
}

const longString = (text) => {
	let level = "="
	while (text.includes(`]${level}]`)) level += "="
	return `[${level}[\n${text}]${level}]`
}

// Writes plugin/ into ServerScriptService.CinqPlugin without untagging it, so Cinq never syncs or stamps that copy.
function buildMirrorCode() {
	const files = fs.readdirSync(source).filter((f) => f.toLowerCase().endsWith(".luau"))
	const puts = files.map((file) => {
		const { name, kind } = parseFile(file)
		const className = kind === "module" ? "ModuleScript" : kind === "local" ? "LocalScript" : "Script"
		const runContext = className === "Script" ? `Enum.RunContext.${kind[0].toUpperCase()}${kind.slice(1)}` : "nil"
		return `put("${className}", "${name}", ${runContext}, ${longString(fs.readFileSync(path.join(source, file), "utf8"))})`
	})
	return `const SES = game:GetService("ScriptEditorService")
local root = game.ServerScriptService:FindFirstChild("CinqPlugin")
if not root then
	root = Instance.new("Folder")
	root.Name = "CinqPlugin"
	root.Parent = game.ServerScriptService
end
root:AddTag("Cinq_Ignore")
const keep = {}
local changed = 0
local cleaned = 0
const function put(className, name, runContext, source)
	keep[name] = true
	local script = root:FindFirstChild(name)
	if script and script.ClassName ~= className then
		script:Destroy()
		script = nil
	end
	if not script then
		script = Instance.new(className)
		script.Name = name
		script.Parent = root
	end
	if runContext then
		script.RunContext = runContext
	end
	if SES:GetEditorSource(script):gsub("\\r\\n", "\\n") ~= source then
		SES:UpdateSourceAsync(script, function() return source end)
		changed += 1
	end
end
${puts.join("\n")}
for _, child in root:GetChildren() do
	if child:IsA("LuaSourceContainer") and not keep[child.Name] then
		child:Destroy()
	end
end
for _, script in root:QueryDescendants("LuaSourceContainer") do
	for attribute in script:GetAttributes() do
		if attribute:match("^Cinq") then
			script:SetAttribute(attribute, nil)
			cleaned += 1
		end
	end
end
return \`Mirrored ${files.length} scripts into ServerScriptService.CinqPlugin ({changed} changed, {cleaned} Cinq attributes removed)\``
}

function main(argv = process.argv.slice(2)) {
	const model = writeRbxm([dirNode(source, "CinqPlugin")])
	fs.mkdirSync(path.dirname(dist), { recursive: true })
	fs.writeFileSync(dist, model)
	console.log(`Built ${dist}`)
	if (argv.includes("--no-install")) return
	fs.mkdirSync(pluginsDir, { recursive: true })
	fs.rmSync(path.join(pluginsDir, "Cinq.rbxmx"), { force: true })
	fs.writeFileSync(path.join(pluginsDir, "Cinq.rbxm"), model)
	console.log(`Installed to ${path.join(pluginsDir, "Cinq.rbxm")}`)
}

if (require.main === module) main()

module.exports = { main, buildMirrorCode }
