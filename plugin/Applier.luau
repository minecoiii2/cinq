const ChangeHistoryService = game:GetService("ChangeHistoryService")
const CollectionService = game:GetService("CollectionService")
const ScriptEditorService = game:GetService("ScriptEditorService")

const Constants = require(script.Parent.Constants)
const Drafts = require(script.Parent.Drafts)
const Scanner = require(script.Parent.Scanner)
const Source = require(script.Parent.Source)

export type Result = { ok: boolean, source: string?, error: string?, instance: Instance? }

const CLASS_FOR_KIND = {
	module = "ModuleScript",
	["local"] = "LocalScript",
	server = "Script",
	client = "Script",
	legacy = "Script",
	plugin = "Script",
}
const RUN_CONTEXT = {
	server = Enum.RunContext.Server,
	client = Enum.RunContext.Client,
	legacy = Enum.RunContext.Legacy,
	plugin = Enum.RunContext.Plugin,
}

const Applier = {}

const function alive(instance: Instance?): boolean
	return instance ~= nil and instance:IsDescendantOf(game)
end

const function isService(instance: Instance): boolean
	return instance.Parent == game
end

const function recorded<T>(name: string, fn: () -> T): T
	const recording = ChangeHistoryService:TryBeginRecording(name)
	const ok, result = pcall(fn)
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		)
	end
	if not ok then
		error(result, 0)
	end
	return result
end

const function findChild(parent: Instance, segment: Scanner.Segment): Instance?
	if segment.id then
		return parent:QueryDescendants(`> [${Constants.IdAttribute} = "{segment.id}"]`)[1]
	end
	const first = parent:FindFirstChild(segment.name)
	if not first then
		return nil
	end
	-- Names can hold any character, which selectors can't express, so same-named siblings are collected by hand.
	const named = {}
	for _, child in parent:GetChildren() do
		if child.Name == segment.name then
			table.insert(named, child)
		end
	end
	if #named == 1 then
		return first
	end
	-- Segments only carry ids when several synced siblings share a name, so an unsynced Model can share this one:
	-- prefer the sibling that already holds scripts, then a Folder.
	for _, child in named do
		if child:FindFirstChildWhichIsA("LuaSourceContainer", true) then
			return child
		end
	end
	for _, child in named do
		if child:IsA("Folder") then
			return child
		end
	end
	return first
end

const function resolveParent(segments: { Scanner.Segment }, roots: { [Instance]: boolean }): Instance
	const serviceName = segments[1].name
	assert(table.find(Constants.Services, serviceName), `{serviceName} isn't a synced service`)
	local parent: Instance = game:GetService(serviceName)
	assert(not roots[parent], `{serviceName} is ignored ({Constants.IgnoreTag})`)
	for i = 2, #segments - 1 do
		const segment = segments[i]
		local child = findChild(parent, segment)
		if not child then
			assert(not segment.id, `no instance with {Constants.IdAttribute} {segment.id} under {parent:GetFullName()}`)
			child = Instance.new("Folder")
			child.Name = segment.name
			child.Parent = parent
		end
		assert(not roots[child], `{child:GetFullName()} is ignored ({Constants.IgnoreTag} or a package)`)
		parent = child
	end
	return parent
end

const function pruneEmptyFolders(start: Instance?)
	local node = start
	while node and node.ClassName == "Folder" and not isService(node) and #node:GetChildren() == 0 do
		if CollectionService:HasTag(node, Constants.IgnoreTag) then
			return
		end
		const parent = node.Parent
		node.Parent = nil
		node = parent
	end
end

const function absorbFolder(target: Instance, parent: Instance, roots: { [Instance]: boolean })
	const existing = parent:FindFirstChild(target.Name)
	if existing and existing ~= target and existing.ClassName == "Folder" and not roots[existing] then
		for _, child in existing:GetChildren() do
			child.Parent = target
		end
		existing.Parent = nil
	end
end

const function newScript(kind: string, name: string): LuaSourceContainer
	const instance = Instance.new(CLASS_FOR_KIND[kind]) :: LuaSourceContainer
	instance.Name = name
	if RUN_CONTEXT[kind] then
		(instance :: Script).RunContext = RUN_CONTEXT[kind]
	end
	return instance
end

const function replaceClass(old: LuaSourceContainer, kind: string): LuaSourceContainer
	const replacement = newScript(kind, old.Name)
	for attribute, value in old:GetAttributes() do
		replacement:SetAttribute(attribute, value)
	end
	for _, tag in old:GetTags() do
		replacement:AddTag(tag)
	end
	for _, child in old:GetChildren() do
		child.Parent = replacement
	end
	replacement.Parent = old.Parent
	old.Parent = nil
	return replacement
end

const function setSource(instance: LuaSourceContainer, base: string?, source: string): string
	ScriptEditorService:UpdateSourceAsync(instance, function(current)
		return if base == nil or Source.normalize(current) == base then source else nil
	end)
	Drafts.onEdited(instance)
	return Source.read(instance)
end

function Applier.create(op, roots): Result
	const name = op.segments[#op.segments].name
	const instance = recorded(`Cinq: create {name}`, function()
		const parent = resolveParent(op.segments, roots)
		const created = newScript(op.kind, name)
		created:SetAttribute(Constants.IdAttribute, op.id)
		created.Parent = parent
		if op.isDir then
			absorbFolder(created, parent, roots)
		end
		return created
	end)
	return { ok = true, source = setSource(instance, nil, op.source), instance = instance }
end

function Applier.update(op, instance: LuaSourceContainer): Result
	const current = Source.read(instance)
	if current ~= op.base then
		return { ok = false, source = current }
	end
	const after = setSource(instance, op.base, op.source)
	return { ok = after == op.source, source = after }
end

-- A directory rename on disk shows up as every script under it moving. When the renamed level is a
-- non-Folder container, Cinq can't rename it, so the move is refused instead of splitting it into a new Folder.
const function containerRenameError(instance: Instance, segments: { Scanner.Segment }): string?
	const service = game:GetService(segments[1].name)
	if not instance:IsDescendantOf(service) then
		return nil
	end
	const chain: { Instance } = {}
	local node = instance.Parent
	while node and node ~= service do
		table.insert(chain, 1, node)
		node = node.Parent
	end
	if #chain ~= #segments - 2 then
		return nil
	end
	for i, container in chain do
		if container.Name == segments[i + 1].name then
			continue
		end
		if container:IsA("Folder") or container:IsA("LuaSourceContainer") then
			return nil
		end
		for j = i + 1, #chain do
			if chain[j].Name ~= segments[j + 1].name then
				return nil
			end
		end
		if instance.Name ~= segments[#segments].name then
			return nil
		end
		local parent: Instance = service
		for j = 2, i + 1 do
			const child = findChild(parent, segments[j])
			if not child then
				return `{container:GetFullName()} is a {container.ClassName}, rename or move it in Studio (from disk Cinq only renames Folders)`
			end
			parent = child
		end
		return nil
	end
	return nil
end

function Applier.move(op, instance: LuaSourceContainer, roots): Result
	const refusal = containerRenameError(instance, op.segments)
	if refusal then
		return { ok = false, error = refusal }
	end
	const source = Source.read(instance)
	const moved = recorded(`Cinq: move {instance.Name}`, function()
		const oldParent = instance.Parent
		const parent = resolveParent(op.segments, roots)
		local target = instance
		if target.ClassName ~= CLASS_FOR_KIND[op.kind] then
			target = replaceClass(target, op.kind)
		end
		if RUN_CONTEXT[op.kind] then
			(target :: Script).RunContext = RUN_CONTEXT[op.kind]
		end
		target.Name = op.segments[#op.segments].name
		target.Parent = parent
		if op.isDir then
			absorbFolder(target, parent, roots)
		end
		if oldParent ~= parent then
			pruneEmptyFolders(oldParent)
		end
		return target
	end)
	if moved ~= instance then
		return { ok = true, source = setSource(moved, nil, source), instance = moved }
	end
	return { ok = true, source = source, instance = moved }
end

function Applier.delete(instance: LuaSourceContainer): Result
	recorded(`Cinq: delete {instance.Name}`, function()
		const parent = instance.Parent
		if instance:FindFirstChildWhichIsA("LuaSourceContainer", true) then
			const folder = Instance.new("Folder")
			folder.Name = instance.Name
			for _, child in instance:GetChildren() do
				child.Parent = folder
			end
			folder.Parent = parent
		end
		instance.Parent = nil
		pruneEmptyFolders(parent)
	end)
	return { ok = true }
end

function Applier.apply(op, byId: { [string]: Instance }): Result
	const roots = Scanner.ignoredRoots()
	const instance = byId[op.id]
	if op.op == "create" then
		return Applier.create(op, roots)
	elseif op.op == "delete" and not alive(instance) then
		return { ok = true }
	elseif not alive(instance) or not (instance :: Instance):IsA("LuaSourceContainer") then
		return { ok = false, error = `no script with {Constants.IdAttribute} {op.id}` }
	elseif Scanner.isIgnored(instance :: Instance, roots) then
		return { ok = false, error = `{(instance :: Instance):GetFullName()} is ignored ({Constants.IgnoreTag} or a package)` }
	elseif op.op == "delete" then
		return Applier.delete(instance :: LuaSourceContainer)
	elseif op.op == "update" then
		return Applier.update(op, instance :: LuaSourceContainer)
	elseif op.op == "move" then
		return Applier.move(op, instance :: LuaSourceContainer, roots)
	end
	return { ok = false, error = `unknown op {op.op}` }
end

return Applier
