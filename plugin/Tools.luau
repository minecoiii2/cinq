const ChangeHistoryService = game:GetService("ChangeHistoryService")
const CollectionService = game:GetService("CollectionService")
const HttpService = game:GetService("HttpService")
const LogService = game:GetService("LogService")
const ReflectionService = game:GetService("ReflectionService")
const ScriptEditorService = game:GetService("ScriptEditorService")
const Selection = game:GetService("Selection")
const StudioService = game:GetService("StudioService")

const Constants = require(script.Parent.Constants)
const Drafts = require(script.Parent.Drafts)
const Scanner = require(script.Parent.Scanner)
const Source = require(script.Parent.Source)

const MAX_LINE = 300
const MAX_TEXT = 12000
const MAX_READ_LINES = 2000
const MAX_READ_LINE = 2000
const MAX_READ_TEXT = 200000
const MAX_SELECTED = 20
const MAX_SELECTED_LINES = 60
const CURSOR_CONTEXT = 3
const MAX_DATAMODEL_NODES = 300000
const MAX_UNSYNCED_SOURCE_BYTES = 30000000
-- Not synced, but scripts index into them; maps in Workspace can be huge, so only the top levels.
const SHALLOW_SERVICES = { Workspace = 4, Teams = 1 }
const SKIPPED_PROPERTIES = { Name = true, ClassName = true, Parent = true, Source = true }
const MESSAGE_PREFIX = {
	[Enum.MessageType.MessageError] = "E",
	[Enum.MessageType.MessageWarning] = "W",
	[Enum.MessageType.MessageInfo] = "I",
	[Enum.MessageType.MessageOutput] = " ",
}

const Tools = {}

const function clip(text: string, limit: number): string
	return if #text > limit then string.sub(text, 1, limit) .. "…" else text
end

const function clamp(value: any, default: number, max: number): number
	return math.clamp(math.floor(tonumber(value) or default), 1, max)
end

const function round(n: number): string
	if n == math.floor(n) and math.abs(n) < 1e15 then
		return tostring(n)
	end
	return (string.gsub(string.format("%.3f", n), "%.?0+$", ""))
end

const ESCAPES = { n = "\n", r = "\r", t = "\t" }

const function formatName(name: string): string
	if name ~= "" and not string.find(name, "[%./%[%c]") and not string.find(name, "^%s") and not string.find(name, "%s$") then
		return name
	end
	const escaped = string.gsub(name, '[\\"%c]', function(char)
		return if char == "\\" or char == '"' then "\\" .. char
			elseif char == "\n" then "\\n"
			elseif char == "\r" then "\\r"
			elseif char == "\t" then "\\t"
			else string.format("\\%03d", string.byte(char))
	end)
	return `["{escaped}"]`
end

const function formatPath(instance: Instance): string
	if instance == game then
		return "game"
	end
	local path = ""
	local current: Instance? = instance
	while current and current ~= game do
		const name = formatName(current.Name)
		path = if path == "" then name elseif string.sub(path, 1, 1) == "[" then name .. path else `{name}.{path}`
		current = current.Parent
	end
	return if current == nil then instance:GetFullName() else path
end

const function readQuoted(path: string, start: number, quote: string): (string, number)
	const parts = {}
	local i = start
	while i <= #path do
		const char = string.sub(path, i, i)
		if char == quote then
			return table.concat(parts), i + 1
		elseif char == "\\" then
			const digits = string.match(path, "^%d%d?%d?", i + 1)
			if digits then
				table.insert(parts, string.char(tonumber(digits) :: number))
				i += 1 + #digits
				continue
			end
			const escaped = string.sub(path, i + 1, i + 1)
			table.insert(parts, ESCAPES[escaped] or escaped)
			i += 2
			continue
		end
		table.insert(parts, char)
		i += 1
	end
	error(`unclosed {quote} in path {path}`, 0)
end

-- Names split on "." or "/"; ["a.b"], ['a.b'] or [a.b] (shells may strip the quotes) hold names containing them.
const function parsePath(path: string): { string }
	const names = {}
	local i = 1
	while i <= #path do
		const char = string.sub(path, i, i)
		if char == "." or char == "/" then
			i += 1
		elseif char == "[" then
			const quote = string.sub(path, i + 1, i + 1)
			if quote == '"' or quote == "'" then
				const name, after = readQuoted(path, i + 2, quote)
				if string.sub(path, after, after) ~= "]" then
					error(`expected ] after {quote}{name}{quote} in path {path}`, 0)
				end
				table.insert(names, name)
				i = after + 1
			else
				const close = string.find(path, "]", i + 1, true)
				if not close then
					error(`unclosed [ in path {path}`, 0)
				end
				table.insert(names, string.sub(path, i + 1, close - 1))
				i = close + 1
			end
		else
			const stop = string.find(path, "[%./%[]", i) or #path + 1
			table.insert(names, string.sub(path, i, stop - 1))
			i = stop
		end
	end
	return names
end

const function resolvePath(path: string?): Instance
	if path == nil or path == "" then
		return game
	end
	const names = parsePath(path)
	if names[1] == "game" then
		table.remove(names, 1)
	end
	local current: Instance = game
	for _, name in names do
		local child = current:FindFirstChild(name)
		if not child and current == game then
			const ok, service = pcall(game.GetService, game, name)
			child = if ok then service else nil
		end
		if not child then
			error(`{formatPath(current)} has no child named {formatName(name)}`, 0)
		end
		current = child
	end
	return current
end

-- The server replaces this marker with the synced file's path.
const function fileOf(instance: Instance): string
	const id = instance:GetAttribute(Constants.IdAttribute)
	return if type(id) == "string" then `⟦file:{id}⟧` else ""
end

const function formatValue(value: any): string
	const kind = typeof(value)
	if kind == "string" then
		return string.format("%q", clip(value, 120))
	elseif kind == "number" then
		return round(value)
	elseif kind == "EnumItem" then
		return value.Name
	elseif kind == "Instance" then
		return formatPath(value)
	elseif kind == "Vector3" then
		return `{round(value.X)}, {round(value.Y)}, {round(value.Z)}`
	elseif kind == "Vector2" then
		return `{round(value.X)}, {round(value.Y)}`
	elseif kind == "Color3" then
		return `rgb({math.round(value.R * 255)}, {math.round(value.G * 255)}, {math.round(value.B * 255)})`
	elseif kind == "BrickColor" then
		return value.Name
	elseif kind == "CFrame" then
		const rx, ry, rz = value:ToOrientation()
		return `pos {formatValue(value.Position)}, rot {round(math.deg(rx))}, {round(math.deg(ry))}, {round(math.deg(rz))}`
	end
	return clip(tostring(value), 120)
end

function Tools.console(args): string
	const limit = clamp(args.lines, 50, 500)
	const grep = if args.grep then string.lower(args.grep) else nil
	const lines = {}
	local lastMessage = nil
	local repeats = 0
	for _, entry in LogService:GetLogHistory() do
		const kind = entry.messageType
		if args.errors and kind ~= Enum.MessageType.MessageError then
			continue
		elseif args.warnings and kind ~= Enum.MessageType.MessageError and kind ~= Enum.MessageType.MessageWarning then
			continue
		elseif grep and not string.find(string.lower(entry.message), grep, 1, true) then
			continue
		end
		if entry.message == lastMessage then
			repeats += 1
			lines[#lines] = string.gsub(lines[#lines], " %(×%d+%)$", "") .. ` (×{repeats + 1})`
			continue
		end
		lastMessage = entry.message
		repeats = 0
		const messageLines = string.split(entry.message, "\n")
		const body = if args.full
			then table.concat(messageLines, "\n    ")
			else messageLines[1] .. (if #messageLines > 1 then ` (+{#messageLines - 1} lines)` else "")
		table.insert(lines, `{os.date("%H:%M:%S", entry.timestamp)} {MESSAGE_PREFIX[kind] or " "} {clip(body, MAX_LINE)}`)
	end
	if #lines == 0 then
		return "No matching output"
	end
	const first = math.max(1, #lines - limit + 1)
	const shown = table.move(lines, first, #lines, 1, {})
	if first > 1 then
		table.insert(shown, 1, `({first - 1} earlier lines not shown, raise --lines to see more)`)
	end
	return table.concat(shown, "\n")
end

function Tools.tree(args): string
	const root = resolvePath(args.path)
	const depth = math.clamp(math.floor(tonumber(args.depth) or 2), 0, 10)
	const limit = clamp(args.limit, 150, 1000)
	const lines = {}
	local omitted = 0
	const function visit(instance: Instance, level: number)
		if #lines >= limit then
			omitted += 1
			return
		end
		const children = instance:GetChildren()
		const suffix = if level == depth and #children > 0 then ` (+{#children})` else ""
		const name = if level == 0 then formatPath(instance) else formatName(instance.Name)
		table.insert(lines, `{string.rep("  ", level)}{name} [{instance.ClassName}]{suffix}`)
		if level < depth then
			for _, child in children do
				visit(child, level + 1)
			end
		end
	end
	visit(root, 0)
	if omitted > 0 then
		table.insert(lines, `… {omitted} more instances not shown, narrow the path or lower --depth`)
	end
	return table.concat(lines, "\n")
end

function Tools.find(args): string
	assert(type(args.selector) == "string" and args.selector ~= "", "find needs a selector, e.g. \"Script\" or \".Tag\"")
	const root = resolvePath(args.within)
	const matches = root:QueryDescendants(args.selector)
	const limit = clamp(args.limit, 50, 1000)
	const lines = { `{#matches} match{if #matches == 1 then "" else "es"} for {args.selector}` }
	for i = 1, math.min(#matches, limit) do
		table.insert(lines, `{formatPath(matches[i])} [{matches[i].ClassName}]`)
	end
	if #matches > limit then
		table.insert(lines, `… {#matches - limit} more, raise --limit to see them`)
	end
	return table.concat(lines, "\n")
end

const propertyCache: { [string]: { string } } = {}

const function readableProperties(className: string): { string }
	const cached = propertyCache[className]
	if cached then
		return cached
	end
	const names = {}
	for _, property in ReflectionService:GetPropertiesOfClass(className) do
		const deprecated = property.Display ~= nil and property.Display.DeprecationMessage ~= nil
		-- Lowercase names are legacy aliases of the real properties.
		if property.Permits and property.Permits.Read ~= nil and not deprecated and string.match(property.Name, "^%u") then
			table.insert(names, property.Name)
		end
	end
	table.sort(names)
	propertyCache[className] = names
	return names
end

function Tools.inspect(args): string
	const instance = resolvePath(args.path)
	const okDefault, default = pcall(Instance.new, instance.ClassName)
	const lines = { `{formatPath(instance)} [{instance.ClassName}]{fileOf(instance)}` }
	local hidden = 0
	for _, name in readableProperties(instance.ClassName) do
		if SKIPPED_PROPERTIES[name] then
			continue
		end
		const ok, value = pcall(function()
			return (instance :: any)[name]
		end)
		if not ok then
			continue
		end
		const formatted = formatValue(value)
		if not args.all and okDefault then
			const okValue, defaultValue = pcall(function()
				return (default :: any)[name]
			end)
			if okValue and formatValue(defaultValue) == formatted then
				hidden += 1
				continue
			end
		end
		table.insert(lines, `  {name} = {formatted}`)
	end
	if okDefault then
		default:Destroy()
	end
	if hidden > 0 then
		table.insert(lines, `  ({hidden} properties at their defaults, --all shows them)`)
	end

	const attributes = instance:GetAttributes()
	const attributeNames = {}
	for name in attributes do
		table.insert(attributeNames, name)
	end
	table.sort(attributeNames)
	for _, name in attributeNames do
		table.insert(lines, `  @{name} = {formatValue(attributes[name])}`)
	end
	const tags = CollectionService:GetTags(instance)
	if #tags > 0 then
		table.insert(lines, `  tags: {table.concat(tags, ", ")}`)
	end
	if instance:IsA("LuaSourceContainer") then
		table.insert(lines, `  source: {#string.split(Source.read(instance), "\n")} lines`)
	end

	const children = instance:GetChildren()
	if #children > 0 then
		const counts: { [string]: number } = {}
		for _, child in children do
			counts[child.ClassName] = (counts[child.ClassName] or 0) + 1
		end
		const classes = {}
		for className, count in counts do
			table.insert(classes, { className = className, count = count })
		end
		table.sort(classes, function(a, b)
			return a.count > b.count
		end)
		const summary = {}
		for i = 1, math.min(#classes, 6) do
			table.insert(summary, `{classes[i].count} {classes[i].className}`)
		end
		table.insert(lines, `  children: {#children} ({table.concat(summary, ", ")}{if #classes > 6 then ", …" else ""})`)
	end
	return table.concat(lines, "\n")
end

const function numbered(lines: { string }, first: number, last: number, marked: number?): { string }
	const out = {}
	for i = math.max(first, 1), math.min(last, #lines) do
		table.insert(out, `{if i == marked then ">" else " "}{i}\t{clip(lines[i], MAX_LINE)}`)
	end
	return out
end

function Tools.selection(): string
	const out = {}
	const selected = Selection:Get()
	if #selected == 0 then
		table.insert(out, "Nothing selected in the Explorer")
	else
		table.insert(out, `Selected ({#selected}):`)
		for i = 1, math.min(#selected, MAX_SELECTED) do
			table.insert(out, `  {formatPath(selected[i])} [{selected[i].ClassName}]{fileOf(selected[i])}`)
		end
		if #selected > MAX_SELECTED then
			table.insert(out, `  … {#selected - MAX_SELECTED} more`)
		end
	end

	const active = StudioService.ActiveScript
	const document = if active then ScriptEditorService:FindScriptDocument(active :: LuaSourceContainer) else nil
	if active and document then
		const cursorLine, cursorColumn, anchorLine, anchorColumn = document:GetSelection()
		const lines = string.split(Source.read(active :: LuaSourceContainer), "\n")
		table.insert(out, `Focused script: {formatPath(active)} [{active.ClassName}]{fileOf(active)}, {#lines} lines`)
		if cursorLine == anchorLine and cursorColumn == anchorColumn then
			table.insert(out, `  Cursor at line {cursorLine}, column {cursorColumn}:`)
			const shown = numbered(lines, cursorLine - CURSOR_CONTEXT, cursorLine + CURSOR_CONTEXT, cursorLine)
			table.move(shown, 1, #shown, #out + 1, out)
		else
			const cursorFirst = cursorLine < anchorLine or (cursorLine == anchorLine and cursorColumn < anchorColumn)
			const first = if cursorFirst then cursorLine else anchorLine
			const last = if cursorFirst then anchorLine else cursorLine
			const startColumn = if cursorFirst then cursorColumn else anchorColumn
			const endColumn = if cursorFirst then anchorColumn else cursorColumn
			table.insert(out, `  Selected from line {first}, column {startColumn} to line {last}, column {endColumn}:`)
			const shown = numbered(lines, first, math.min(last, first + MAX_SELECTED_LINES - 1))
			table.move(shown, 1, #shown, #out + 1, out)
			if last - first + 1 > MAX_SELECTED_LINES then
				table.insert(out, `  … {last - first + 1 - MAX_SELECTED_LINES} more lines, cinq read shows them`)
			end
		end
	else
		table.insert(out, "No script tab is focused")
	end

	const others = {}
	for _, openDocument in ScriptEditorService:GetScriptDocuments() do
		const openScript = if openDocument:IsCommandBar() then nil else openDocument:GetScript()
		if openScript and openScript ~= active then
			table.insert(others, formatPath(openScript))
		end
	end
	if #others > 0 then
		table.sort(others)
		table.insert(out, `Other open tabs ({#others}): {table.concat(others, ", ", 1, math.min(#others, MAX_SELECTED))}{if #others > MAX_SELECTED then ", …" else ""}`)
	end
	return table.concat(out, "\n")
end

const function scriptsUnder(root: Instance): { LuaSourceContainer }
	if root ~= game then
		const scripts = root:QueryDescendants("LuaSourceContainer")
		if root:IsA("LuaSourceContainer") then
			table.insert(scripts, 1, root)
		end
		return scripts :: any
	end
	const scripts = {}
	for _, service in game:GetChildren() do
		const ok, found = pcall(service.QueryDescendants, service, "LuaSourceContainer")
		if ok then
			table.move(found, 1, #found, #scripts + 1, scripts)
		end
	end
	return scripts
end

function Tools.grep(args): string
	assert(type(args.pattern) == "string" and args.pattern ~= "", "grep needs a pattern")
	const ignoreCase = args.ignoreCase == true
	const plain = args.lua ~= true
	const needle = if ignoreCase then string.lower(args.pattern) else args.pattern
	if not plain then
		const ok, problem = pcall(string.find, "", needle)
		if not ok then
			error(`bad Lua pattern: {problem}`, 0)
		end
	end
	const limit = clamp(args.limit, 100, 2000)
	const scripts = scriptsUnder(resolvePath(args.within))
	const blocks = {}
	local matches = 0
	local scriptsMatched = 0
	for _, script in scripts do
		const ok, source = pcall(Source.read, script)
		if not ok then
			continue
		end
		local block = nil
		for lineNumber, line in string.split(source, "\n") do
			if not string.find(if ignoreCase then string.lower(line) else line, needle, 1, plain) then
				continue
			end
			matches += 1
			if matches > limit then
				continue
			end
			if not block then
				scriptsMatched += 1
				block = { `{formatPath(script)} [{script.ClassName}]{fileOf(script)}` }
				table.insert(blocks, block)
			end
			table.insert(block, `  {lineNumber}: {clip((string.gsub(line, "^%s+", "")), MAX_LINE)}`)
		end
	end
	if matches == 0 then
		return `No matches in {#scripts} scripts`
	end
	const lines = { `{matches} match{if matches == 1 then "" else "es"} in {#scripts} scripts searched` }
	for _, block in blocks do
		table.move(block, 1, #block, #lines + 1, lines)
	end
	if matches > limit then
		table.insert(lines, `… {matches - limit} more matches not shown, narrow --in or raise --limit`)
	end
	return table.concat(lines, "\n")
end

-- Scripts whose draft differs from the committed source (.Source is the committed one when Drafts mode is on).
function Tools.drafts(args): string
	if type(args.rebase) == "table" then
		for _, target in args.rebase do
			Drafts.rebase(resolvePath(target) :: any)
		end
		return "[]"
	end
	const found = {}
	for _, instance in scriptsUnder(resolvePath(args.within)) do
		const okDraft, draft = pcall(Source.read, instance)
		const okCommitted, committed = pcall(function()
			return Source.normalize((instance :: any).Source)
		end)
		if not okDraft or not okCommitted then
			continue
		end
		if draft == committed then
			Drafts.forget(instance)
			continue
		end
		table.insert(found, {
			path = formatPath(instance),
			className = instance.ClassName,
			file = fileOf(instance),
			draft = draft,
			committed = committed,
			base = Drafts.baseOf(instance),
			tracked = Drafts.isTracked(instance),
		})
	end
	return HttpService:JSONEncode(found)
end

-- Instance tree for a Rojo-style sourcemap, as [name, className, id, children, source?] so it stays small.
-- Scripts Cinq doesn't sync (packages, ignored, outside the synced services) carry their source so requires still resolve.
function Tools.datamodel(): string
	const ignoredRoots = Scanner.ignoredRoots()
	local count = 0
	local sourceBytes = 0
	const function node(instance: Instance, depthLeft: number, synced: boolean): { any }
		count += 1
		const isSynced = synced and not ignoredRoots[instance]
		const id = instance:GetAttribute(Constants.IdAttribute)
		const children = {}
		if depthLeft > 0 and count < MAX_DATAMODEL_NODES then
			for _, child in instance:GetChildren() do
				table.insert(children, node(child, depthLeft - 1, isSynced))
			end
		end
		const result = { instance.Name, instance.ClassName, if isSynced and type(id) == "string" then id else 0, children }
		if not isSynced and instance:IsA("LuaSourceContainer") and sourceBytes < MAX_UNSYNCED_SOURCE_BYTES then
			const ok, source = pcall(Source.read, instance :: LuaSourceContainer)
			if ok then
				sourceBytes += #source
				result[5] = source
			end
		end
		return result
	end
	const roots = {}
	for _, name in Constants.Services do
		table.insert(roots, node(game:GetService(name), math.huge, true))
	end
	for name, depth in SHALLOW_SERVICES do
		const service = game:FindFirstChildOfClass(name)
		if service then
			table.insert(roots, node(service, depth, false))
		end
	end
	return HttpService:JSONEncode(roots)
end

const function scriptAt(path: string?): LuaSourceContainer
	const instance = resolvePath(path)
	if not instance:IsA("LuaSourceContainer") then
		error(`{formatPath(instance)} is a {instance.ClassName}, not a script`, 0)
	end
	return instance :: LuaSourceContainer
end

function Tools.read(args): string
	const script = scriptAt(args.path)
	const lines = string.split(Source.read(script), "\n")
	const first = math.clamp(math.floor(tonumber(args.from) or 1), 1, math.max(#lines, 1))
	const wantedLast = math.min(#lines, math.floor(tonumber(args.to) or #lines))
	const last = math.min(wantedLast, first + MAX_READ_LINES - 1)
	const out = { `{formatPath(script)} [{script.ClassName}]{fileOf(script)}, {#lines} lines` }
	for i = first, last do
		table.insert(out, `{i}\t{clip(lines[i], MAX_READ_LINE)}`)
	end
	if last < wantedLast then
		table.insert(out, `(lines {last + 1}-{#lines} not shown, read them with --from {last + 1})`)
	end
	return table.concat(out, "\n")
end

const function replacePlain(text: string, old: string, new: string, all: boolean): (string, number)
	const parts = {}
	local count = 0
	local position = 1
	while true do
		const start, finish = string.find(text, old, position, true)
		if not start then
			break
		end
		count += 1
		table.insert(parts, string.sub(text, position, start - 1))
		table.insert(parts, new)
		position = finish + 1
		if not all then
			break
		end
	end
	table.insert(parts, string.sub(text, position))
	return table.concat(parts), count
end

const function countPlain(text: string, old: string): number
	local count = 0
	local position = 1
	while true do
		const _, finish = string.find(text, old, position, true)
		if not finish then
			return count
		end
		count += 1
		position = finish + 1
	end
end

const function applyEdits(text: string, edits: { any }): string
	for i, edit in edits do
		const label = if #edits > 1 then `edit {i}: ` else ""
		assert(type(edit.old) == "string" and type(edit.new) == "string", `{label}needs old and new strings`)
		if edit.old == "" then
			error(`{label}old is empty`, 0)
		end
		const old = Source.normalize(edit.old)
		const matches = countPlain(text, old)
		if matches == 0 then
			error(`{label}old text not found, nothing was changed`, 0)
		elseif matches > 1 and not edit.all then
			error(`{label}old text matches {matches} times, add more context or set all, nothing was changed`, 0)
		end
		text = replacePlain(text, old, Source.normalize(edit.new), edit.all == true)
	end
	return text
end

function Tools.edit(args): string
	const script = scriptAt(args.path)
	assert(type(args.edits) == "table" and #args.edits > 0, "edit needs at least one {old, new} edit")
	const before = Source.read(script)
	local wanted: string? = nil
	local failure: string? = nil
	const recording = ChangeHistoryService:TryBeginRecording("Cinq: edit")
	ScriptEditorService:UpdateSourceAsync(script, function(current)
		const ok, result = pcall(applyEdits, Source.normalize(current), args.edits)
		if not ok then
			failure = result
			return nil
		end
		wanted = result
		return result
	end)
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	if failure then
		error(failure, 0)
	end
	const after = Source.read(script)
	if after ~= wanted then
		error(`{formatPath(script)} didn't take the edit (Studio's source doesn't match what was written)`, 0)
	end
	const linesBefore = #string.split(before, "\n")
	const linesAfter = #string.split(after, "\n")
	return `Edited {formatPath(script)}: {#args.edits} edit{if #args.edits == 1 then "" else "s"}, {linesBefore} → {linesAfter} lines`
end

const function formatResult(value: any): string
	if type(value) == "table" then
		const ok, encoded = pcall(HttpService.JSONEncode, HttpService, value)
		return clip(if ok then encoded else tostring(value), 2000)
	end
	return formatValue(value)
end

function Tools.exec(args): string
	assert(type(args.code) == "string", "exec needs code")
	const chunk, compileError = loadstring(args.code, "=cinq")
	if not chunk then
		error(compileError, 0)
	end
	const output = {}
	const function capture(prefix: string)
		return function(...)
			const parts = {}
			for i = 1, select("#", ...) do
				parts[i] = tostring((select(i, ...)))
			end
			table.insert(output, prefix .. table.concat(parts, " "))
		end
	end
	setfenv(chunk, setmetatable({ print = capture(""), warn = capture("W ") }, { __index = getfenv() }))
	const recording = ChangeHistoryService:TryBeginRecording("Cinq: exec")
	const results = table.pack(pcall(chunk))
	-- Committed even after an error so whatever ran before it can still be undone.
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	if not results[1] then
		table.insert(output, `error: {results[2]}`)
	else
		for i = 2, results.n do
			table.insert(output, `→ {formatResult(results[i])}`)
		end
	end
	return if #output == 0 then "(no output)" else clip(table.concat(output, "\n"), MAX_TEXT)
end

function Tools.run(name: string, args: { [string]: any }): string
	const tool = (Tools :: any)[name]
	assert(name ~= "run" and type(tool) == "function", `unknown tool {name}`)
	const result = tool(args or {})
	return if name == "datamodel" or name == "drafts" then result else clip(result, if name == "read" then MAX_READ_TEXT else MAX_TEXT)
end

return Tools
