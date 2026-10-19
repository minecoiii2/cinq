const ChangeHistoryService = game:GetService("ChangeHistoryService")
const CollectionService = game:GetService("CollectionService")
const HttpService = game:GetService("HttpService")

const Constants = require(script.Parent.Constants)

export type Segment = { name: string, id: string? }
export type Entry = { id: string, segments: { Segment }, kind: string, isDir: boolean, source: string? }
export type ScanResult = {
	entries: { Entry },
	byId: { [string]: Instance },
	scripts: { [Instance]: string },
	relevant: { [Instance]: boolean },
}

const Scanner = {}

function Scanner.newId(): string
	return string.lower(string.sub(string.gsub(HttpService:GenerateGUID(false), "-", ""), 1, 10))
end

function Scanner.kindOf(source: LuaSourceContainer): string
	if source:IsA("ModuleScript") then
		return "module"
	elseif source:IsA("LocalScript") then
		return "local"
	end
	const runContext = (source :: Script).RunContext
	return if runContext == Enum.RunContext.Server
		then "server"
		elseif runContext == Enum.RunContext.Client then "client"
		elseif runContext == Enum.RunContext.Plugin then "plugin"
		else "legacy"
end

function Scanner.ignoredRoots(): { [Instance]: boolean }
	const roots = {}
	for _, name in Constants.Services do
		const service = game:GetService(name)
		if CollectionService:HasTag(service, Constants.IgnoreTag) then
			roots[service] = true
		end
		for _, instance in service:QueryDescendants(`.{Constants.IgnoreTag}`) do
			roots[instance] = true
		end
		-- Any write inside a package, even an attribute, marks it as modified.
		for _, link in service:QueryDescendants("PackageLink") do
			if link.Parent then
				roots[link.Parent] = true
			end
		end
	end
	return roots
end

const function ignoredScripts(roots: { [Instance]: boolean }): { [Instance]: boolean }
	const ignored = {}
	for root in roots do
		if root:IsA("LuaSourceContainer") then
			ignored[root] = true
		end
		for _, source in root:QueryDescendants("LuaSourceContainer") do
			ignored[source] = true
		end
	end
	return ignored
end

function Scanner.isIgnored(instance: Instance, roots: { [Instance]: boolean }): boolean
	local current: Instance? = instance
	while current and current ~= game do
		if roots[current] then
			return true
		end
		current = current.Parent
	end
	return false
end

const function readId(instance: Instance, attribute: string?): string?
	const id = instance:GetAttribute(attribute or Constants.IdAttribute)
	return if typeof(id) == "string" and string.match(id, "^%x+$") then id else nil
end

-- `previous` keeps ids stable when a copy-pasted instance carries the same id as the original,
-- and restores the id of an instance whose attribute was removed.
function Scanner.scan(previous: { [string]: Instance }): ScanResult
	const roots = Scanner.ignoredRoots()
	const ignored = ignoredScripts(roots)
	const services: { [Instance]: boolean } = {}
	const scripts: { LuaSourceContainer } = {}
	const relevant: { [Instance]: boolean } = {}

	for _, name in Constants.Services do
		const service = game:GetService(name)
		services[service] = true
		if roots[service] then
			continue
		end
		for _, source in service:QueryDescendants("LuaSourceContainer") do
			if ignored[source] then
				continue
			end
			table.insert(scripts, source)
			if relevant[source] == nil then
				relevant[source] = false
			end
			local parent = source.Parent
			while parent and parent ~= service do
				relevant[parent] = true
				parent = parent.Parent
			end
		end
	end

	const siblings: { [Instance]: { [string]: { Instance } } } = {}
	for instance in relevant do
		const parent = instance.Parent :: Instance
		const byName = siblings[parent] or {}
		siblings[parent] = byName
		const lower = string.lower(instance.Name)
		byName[lower] = byName[lower] or {}
		table.insert(byName[lower], instance)
	end
	const duplicate: { [Instance]: boolean } = {}
	for _, byName in siblings do
		for _, group in byName do
			if #group > 1 then
				for _, instance in group do
					duplicate[instance] = true
				end
			end
		end
	end

	const needsId: { [Instance]: boolean } = table.clone(duplicate)
	for _, source in scripts do
		needsId[source] = true
	end

	const claimed: { [string]: { Instance } } = {}
	const fresh: { Instance } = {}
	const migrated: { Instance } = {}
	for instance in needsId do
		local id = readId(instance)
		if not id then
			id = readId(instance, Constants.LegacyIdAttribute)
			if id then
				table.insert(migrated, instance)
			end
		end
		if id then
			claimed[id] = claimed[id] or {}
			table.insert(claimed[id], instance)
		else
			table.insert(fresh, instance)
		end
	end
	const byId: { [string]: Instance } = {}
	const losers: { [Instance]: boolean } = {}
	for id, group in claimed do
		const keeper = if previous[id] and table.find(group, previous[id]) then previous[id] else group[1]
		byId[id] = keeper
		for _, instance in group do
			if instance ~= keeper then
				table.insert(fresh, instance)
				losers[instance] = true
			end
		end
	end
	if #fresh > 0 or #migrated > 0 then
		const previousIds: { [Instance]: string } = {}
		for id, instance in previous do
			previousIds[instance] = id
		end
		const recording = ChangeHistoryService:TryBeginRecording("Cinq: assign sync ids")
		for _, instance in migrated do
			if not losers[instance] then
				instance:SetAttribute(Constants.IdAttribute, readId(instance, Constants.LegacyIdAttribute))
			end
			instance:SetAttribute(Constants.LegacyIdAttribute, nil)
		end
		for _, instance in fresh do
			const known = previousIds[instance]
			const id = if known and not byId[known] then known else Scanner.newId()
			instance:SetAttribute(Constants.IdAttribute, id)
			byId[id] = instance
		end
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
	end

	const entries: { Entry } = {}
	const scriptIds: { [Instance]: string } = {}
	for _, source in scripts do
		const id = readId(source) :: string
		scriptIds[source] = id
		const segments: { Segment } = {}
		local node: Instance = source
		while not services[node] do
			table.insert(segments, 1, { name = node.Name, id = if duplicate[node] then readId(node) else nil })
			node = node.Parent :: Instance
		end
		table.insert(segments, 1, { name = node.Name })
		table.insert(entries, { id = id, segments = segments, kind = Scanner.kindOf(source), isDir = relevant[source] == true })
	end

	return { entries = entries, byId = byId, scripts = scriptIds, relevant = relevant }
end

return Scanner
