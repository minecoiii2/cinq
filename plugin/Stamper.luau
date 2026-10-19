const ScriptEditorService = game:GetService("ScriptEditorService")
const StudioService = game:GetService("StudioService")

const Constants = require(script.Parent.Constants)
const Hash = require(script.Parent.Hash)
const Scanner = require(script.Parent.Scanner)
const Source = require(script.Parent.Source)

const Stamper = {}
Stamper.__index = Stamper

export type Stamper = typeof(setmetatable(
	{} :: { pending: { [Instance]: boolean }, scheduled: boolean, connection: RBXScriptConnection? },
	Stamper
))

const function isSynced(instance: Instance): boolean
	for _, name in Constants.Services do
		if instance:IsDescendantOf(game:GetService(name)) then
			return not Scanner.isIgnored(instance, Scanner.ignoredRoots())
		end
	end
	return false
end

-- With Live Scripting a collaborator's typing changes this user's open tab too, but leaves this user's cursor where it
-- was, while this user's own typing always ends with the cursor inside the changed text.
const function typedHere(document: ScriptDocument, changes: { any }): boolean
	const cursorLine = document:GetSelection()
	for _, change in changes do
		const first = change.range.start.line
		const _, newlines = string.gsub(change.text, "\n", "")
		if cursorLine >= first and cursorLine <= first + newlines then
			return true
		end
	end
	return false
end

-- Marks scripts this user edits with their UserId and a hash of the source, even while the server is down.
function Stamper.new(): Stamper
	const self = setmetatable({ pending = {}, scheduled = false, connection = nil }, Stamper)
	self.connection = ScriptEditorService.TextDocumentDidChange:Connect(function(document, changes)
		if document:IsCommandBar() then
			return
		end
		const source = document:GetScript()
		if source ~= StudioService.ActiveScript or not typedHere(document, changes) then
			return
		end
		self.pending[source] = true
		if not self.scheduled then
			self.scheduled = true
			task.delay(Constants.EventIntervalSeconds, function()
				self:flush()
			end)
		end
	end)
	return self
end

function Stamper.stamp(self: Stamper, instance: Instance)
	if not instance:IsDescendantOf(game) or not isSynced(instance) then
		return
	end
	const hash = Hash(Source.read(instance))
	if instance:GetAttribute(Constants.EditorAttribute) ~= Constants.UserId then
		instance:SetAttribute(Constants.EditorAttribute, Constants.UserId)
	end
	if instance:GetAttribute(Constants.EditorHashAttribute) ~= hash then
		instance:SetAttribute(Constants.EditorHashAttribute, hash)
	end
end

function Stamper.flush(self: Stamper)
	self.scheduled = false
	const pending = self.pending
	self.pending = {}
	for instance in pending do
		self:stamp(instance)
	end
end

function Stamper.destroy(self: Stamper)
	self:flush()
	if self.connection then
		self.connection:Disconnect()
	end
end

return Stamper
