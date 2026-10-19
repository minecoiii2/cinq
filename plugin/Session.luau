const CollectionService = game:GetService("CollectionService")
const MarketplaceService = game:GetService("MarketplaceService")
const Players = game:GetService("Players")
const ScriptEditorService = game:GetService("ScriptEditorService")

const Applier = require(script.Parent.Applier)
const Constants = require(script.Parent.Constants)
const Drafts = require(script.Parent.Drafts)
const Http = require(script.Parent.Http)
const Scanner = require(script.Parent.Scanner)
const Source = require(script.Parent.Source)
const Stamper = require(script.Parent.Stamper)
const Tools = require(script.Parent.Tools)

const MAX_EVENTS_PER_REQUEST = 200
const SWEEP_INTERVAL_SECONDS = 5

const Session = {}
Session.__index = Session

export type Session = typeof(setmetatable(
	{} :: {
		active: boolean,
		token: string?,
		after: number,
		byId: { [string]: Instance },
		scriptIds: { [Instance]: string },
		lastSource: { [string]: string },
		lastTree: string?,
		watched: { [Instance]: { RBXScriptConnection } },
		connections: { RBXScriptConnection },
		dirtySources: { [Instance]: boolean },
		stamper: Stamper.Stamper?,
		userNames: { [number]: string | boolean },
		rescanScheduled: boolean,
		outbox: { any },
		sending: boolean,
		lastSend: number,
		status: string?,
		onStatus: (string, boolean) -> (),
	},
	Session
))

function Session.new(onStatus: (string, boolean) -> ()): Session
	return setmetatable({
		active = false,
		token = nil,
		after = 0,
		byId = {},
		scriptIds = {},
		lastSource = {},
		lastTree = nil,
		watched = {},
		connections = {},
		dirtySources = {},
		stamper = nil,
		userNames = {},
		rescanScheduled = false,
		outbox = {},
		sending = false,
		lastSend = 0,
		status = nil,
		onStatus = onStatus,
	}, Session)
end

function Session.setStatus(self: Session, status: string, isProblem: boolean?)
	if self.status ~= status then
		self.status = status
		self.onStatus(status, isProblem == true)
	end
end

function Session.start(self: Session)
	self.active = true
	self.stamper = Stamper.new()
	task.spawn(function()
		while self.active do
			const ok, err = pcall(self.connect, self)
			if not ok then
				self:teardown()
				self:setStatus(
					if string.find(tostring(err), "HttpError")
						then `Waiting for the Cinq server at {Constants.Url}`
						else `Couldn't connect: {err}`,
					true
				)
				task.wait(2)
				continue
			end
			if not self.active then
				-- Stopped while the connect request was in flight.
				const token = self.token
				self:teardown()
				task.spawn(pcall, Http.request, "POST", "/disconnect", { session = token })
				break
			end
			const reason = self:pollLoop()
			self:teardown()
			if reason == "superseded" then
				self:setStatus("Another Studio connected to this place, stopped syncing", true)
				self:stop()
			elseif self.active then
				self:setStatus(`Connection lost ({reason}), reconnecting`, true)
				task.wait(1)
			end
		end
	end)
end

function Session.stop(self: Session)
	self.active = false
	if self.stamper then
		self.stamper:destroy()
		self.stamper = nil
	end
	const token = self.token
	self:teardown()
	if token then
		task.spawn(pcall, Http.request, "POST", "/disconnect", { session = token })
	end
	self:setStatus("Disconnected")
end

local cachedPlaceName: string? = nil

-- game.Name isn't reliable for published places (it can read "Game"), so ask for the real place name.
function Session.placeName(): string
	if cachedPlaceName then
		return cachedPlaceName
	end
	if game.PlaceId ~= 0 then
		const ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, game.PlaceId)
		if ok and type(info) == "table" and type(info.Name) == "string" and info.Name ~= "" then
			cachedPlaceName = info.Name
			return info.Name
		end
	end
	return game.Name
end

function Session.connect(self: Session)
	const status, body = Http.request("POST", "/connect", { placeId = game.PlaceId, placeName = Session.placeName() })
	assert(status == 200 and body, `connect failed ({status})`)
	self.token = body.session
	self.after = 0
	self:watchGlobal()
	self:sendSnapshot()
	self:sweepLoop()
	self:setStatus(`Connected, syncing into {body.dir}`)
end

function Session.teardown(self: Session)
	self.token = nil
	for _, connection in self.connections do
		connection:Disconnect()
	end
	for _, connections in self.watched do
		for _, connection in connections do
			connection:Disconnect()
		end
	end
	self.connections = {}
	self.watched = {}
	self.byId = {}
	self.scriptIds = {}
	self.lastSource = {}
	self.lastTree = nil
	self.dirtySources = {}
	self.outbox = {}
end

function Session.enqueue(self: Session, event: any)
	table.insert(self.outbox, event)
	self:kick()
end

function Session.collectSources(self: Session)
	if self.stamper then
		self.stamper:flush()
	end
	const dirty = self.dirtySources
	self.dirtySources = {}
	for instance in dirty do
		const id = self.scriptIds[instance]
		if not id or not instance:IsDescendantOf(game) then
			continue
		end
		const source = Source.read(instance)
		if source ~= self.lastSource[id] then
			self.lastSource[id] = source
			table.insert(self.outbox, self:withEditor({ type = "source", id = id, source = source }, instance))
		end
	end
end

function Session.withEditor(self: Session, event: any, instance: Instance): any
	const by = instance:GetAttribute(Constants.EditorAttribute)
	if typeof(by) == "number" then
		event.by = by
		event.byHash = instance:GetAttribute(Constants.EditorHashAttribute)
		self:resolveName(by)
	end
	return event
end

function Session.resolveName(self: Session, userId: number)
	if self.userNames[userId] ~= nil then
		return
	end
	self.userNames[userId] = false
	task.spawn(function()
		const ok, name = pcall(Players.GetNameFromUserIdAsync, Players, userId)
		if ok and self.token then
			self.userNames[userId] = name
			self:enqueue({ type = "users", names = { [tostring(userId)] = name } })
		end
	end)
end

function Session.kick(self: Session)
	if self.sending then
		return
	end
	self.sending = true
	-- Deferred so the Stamper's handler for the same edit runs before the source is read and sent.
	task.defer(function()
		while self.token and (#self.outbox > 0 or next(self.dirtySources) ~= nil) do
			const isSnapshot = self.outbox[1] ~= nil and self.outbox[1].type == "snapshot"
			-- Polled rather than one long wait so a flush (lastSend = 0) sends right away.
			while not isSnapshot and self.token and os.clock() < self.lastSend + Constants.EventIntervalSeconds do
				task.wait(0.05)
			end
			if not self.token then
				break
			end
			self:collectSources()
			if #self.outbox == 0 then
				break
			end
			const batch = {}
			while #self.outbox > 0 and #batch < MAX_EVENTS_PER_REQUEST do
				const nextEvent = self.outbox[1]
				if #batch > 0 and nextEvent.type == "snapshot" then
					break
				end
				table.insert(batch, table.remove(self.outbox, 1))
				if nextEvent.type == "snapshot" then
					break
				end
			end
			const ok, status = pcall(Http.request, "POST", "/events", { session = self.token, events = batch })
			self.lastSend = os.clock()
			if not ok or status ~= 200 then
				-- Dropping the token ends the poll loop, and reconnecting resends a full snapshot.
				self.outbox = {}
				self.token = nil
				break
			end
		end
		self.sending = false
	end)
end

function Session.sendSnapshot(self: Session)
	const result = Scanner.scan(self.byId)
	self:adopt(result)
	local chunk = {}
	local size = 0
	for _, entry in result.entries do
		const source = Source.read(self.byId[entry.id])
		entry.source = source
		self.lastSource[entry.id] = source
		table.insert(chunk, self:withEditor(entry, self.byId[entry.id]))
		size += #source
		if size >= Constants.SnapshotChunkBytes then
			self:enqueue({ type = "snapshot", entries = chunk, final = false })
			chunk = {}
			size = 0
		end
	end
	self:enqueue({ type = "snapshot", entries = chunk, final = true })
	self.lastTree = Session.treeKey(result.entries)
end

function Session.treeKey(entries: { Scanner.Entry }): string
	const keys = {}
	for _, entry in entries do
		const names = {}
		for _, segment in entry.segments do
			table.insert(names, segment.name .. "~" .. (segment.id or ""))
		end
		table.insert(keys, `{entry.id}|{entry.kind}|{entry.isDir}|{table.concat(names, "/")}`)
	end
	table.sort(keys)
	return table.concat(keys, "\n")
end

function Session.adopt(self: Session, result: Scanner.ScanResult)
	self.byId = result.byId
	self.scriptIds = result.scripts
	for instance, connections in self.watched do
		if result.relevant[instance] == nil then
			for _, connection in connections do
				connection:Disconnect()
			end
			self.watched[instance] = nil
		end
	end
	for instance in result.relevant do
		if self.watched[instance] then
			continue
		end
		const connections = {
			instance:GetPropertyChangedSignal("Name"):Connect(function()
				self:scheduleRescan()
			end),
		}
		if instance:IsA("LuaSourceContainer") then
			Drafts.track(instance)
			table.insert(
				connections,
				instance:GetPropertyChangedSignal("Source"):Connect(function()
					Drafts.onCommitted(instance)
					self:markDirty(instance)
				end)
			)
			table.insert(
				connections,
				instance:GetAttributeChangedSignal(Constants.IdAttribute):Connect(function()
					self:scheduleRescan()
				end)
			)
		end
		if instance:IsA("Script") and not instance:IsA("LocalScript") then
			table.insert(
				connections,
				instance:GetPropertyChangedSignal("RunContext"):Connect(function()
					self:scheduleRescan()
				end)
			)
		end
		self.watched[instance] = connections
	end
end

function Session.watchGlobal(self: Session)
	const function onTreeChange(instance: Instance)
		if
			instance:IsA("LuaSourceContainer")
			or instance:IsA("PackageLink")
			or instance:FindFirstChildWhichIsA("LuaSourceContainer", true)
		then
			self:scheduleRescan()
		end
	end
	const rescan = function()
		self:scheduleRescan()
	end
	for _, name in Constants.Services do
		const service = game:GetService(name)
		table.insert(self.connections, service.DescendantAdded:Connect(onTreeChange))
		table.insert(self.connections, service.DescendantRemoving:Connect(onTreeChange))
	end
	table.insert(self.connections, CollectionService:GetInstanceAddedSignal(Constants.IgnoreTag):Connect(rescan))
	table.insert(self.connections, CollectionService:GetInstanceRemovedSignal(Constants.IgnoreTag):Connect(rescan))
	table.insert(
		self.connections,
		ScriptEditorService.TextDocumentDidChange:Connect(function(document)
			if not document:IsCommandBar() then
				const edited = document:GetScript()
				Drafts.onEdited(edited)
				self:markDirty(edited)
			end
		end)
	)
end

function Session.markDirty(self: Session, instance: Instance)
	if not self.scriptIds[instance] then
		return
	end
	self.dirtySources[instance] = true
	self:kick()
end

function Session.scheduleRescan(self: Session)
	if self.rescanScheduled then
		return
	end
	self.rescanScheduled = true
	task.delay(0.05, function()
		self.rescanScheduled = false
		if self.token then
			self:rescan(false)
		end
	end)
end

function Session.rescan(self: Session, force: boolean)
	const result = Scanner.scan(self.byId)
	self:adopt(result)
	const lastSource = {}
	for _, entry in result.entries do
		const known = self.lastSource[entry.id]
		if known then
			lastSource[entry.id] = known
		else
			const source = Source.read(self.byId[entry.id])
			entry.source = source
			lastSource[entry.id] = source
			self:withEditor(entry, self.byId[entry.id])
		end
	end
	self.lastSource = lastSource
	const key = Session.treeKey(result.entries)
	if force or key ~= self.lastTree then
		self.lastTree = key
		self:enqueue({ type = "tree", entries = result.entries })
	end
end

function Session.apply(self: Session, op: any)
	const ok, result = pcall(Applier.apply, op, self.byId)
	if not ok then
		self:enqueue({ type = "applied", opId = op.opId, ok = false, error = tostring(result) })
		return
	end
	if result.instance then
		self.byId[op.id] = result.instance
		self.scriptIds[result.instance] = op.id
	end
	if result.source then
		self.lastSource[op.id] = result.source
	end
	const target = result.instance or self.byId[op.id]
	if result.ok and op.op ~= "delete" and target and self.stamper then
		self.stamper:stamp(target)
	end
	self:enqueue({ type = "applied", opId = op.opId, ok = result.ok, source = result.source, error = result.error })
end

-- In Drafts mode an edit that isn't typed into an open tab (a plugin's, cinq edit or exec, Studio's own draft merge)
-- changes neither .Source nor a ScriptDocument, so no signal fires; comparing against what was last sent catches it.
function Session.sweep(self: Session): number
	const started = os.clock()
	for instance, id in self.scriptIds do
		if self.dirtySources[instance] or self.lastSource[id] == nil then
			continue
		end
		const ok, source = pcall(Source.read, instance :: LuaSourceContainer)
		if ok and source ~= self.lastSource[id] then
			self:markDirty(instance)
		end
	end
	return os.clock() - started
end

function Session.sweepLoop(self: Session)
	const token = self.token
	task.spawn(function()
		while self.token == token do
			const took = self:sweep()
			-- A big place takes longer to read, so it's swept less often to keep Studio responsive.
			task.wait(math.max(SWEEP_INTERVAL_SECONDS, took * 50))
		end
	end)
end

function Session.flush(self: Session): string
	self:sweep()
	self.lastSend = 0
	self:kick()
	const deadline = os.clock() + 5
	while (self.sending or #self.outbox > 0 or next(self.dirtySources) ~= nil) and os.clock() < deadline do
		task.wait(0.05)
	end
	return "flushed"
end

function Session.runTool(self: Session, op: any)
	const token = self.token
	const ok, result = pcall(function()
		return if op.tool == "flush" then self:flush() else Tools.run(op.tool, op.args)
	end)
	if op.tool == "exec" or op.tool == "edit" then
		self:sweep()
	end
	pcall(Http.request, "POST", "/tool/result", {
		session = token,
		requestId = op.requestId,
		ok = ok,
		text = if ok then result else nil,
		error = if ok then nil else tostring(result),
	})
end

function Session.pollLoop(self: Session): string
	const token = self.token
	local failures = 0
	while self.active and self.token == token do
		const ok, status, body = pcall(Http.request, "GET", `/poll?session={token}&after={self.after}`)
		if not ok then
			failures += 1
			if failures >= 3 then
				return tostring(status)
			end
			task.wait(1)
			continue
		end
		if status == 409 then
			return if body then body.error else "session ended"
		end
		failures = 0
		if status == 200 and body and #body.ops > 0 then
			local applied = false
			for _, op in body.ops do
				if op.seq <= self.after then
					continue
				end
				if op.op == "tool" then
					task.spawn(self.runTool, self, op)
				else
					self:apply(op)
					applied = true
				end
				self.after = op.seq
			end
			if applied then
				self:rescan(true)
			end
		end
	end
	return "stopped"
end

return Session
