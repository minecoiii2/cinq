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

-- Marks scripts this user edits with their UserId and a hash of the source, even while the server is down.
function Stamper.new(): Stamper
	const self = setmetatable({ pending = {}, scheduled = false, connection = nil }, Stamper)
	self.connection = ScriptEditorService.TextDocumentDidChange:Connect(function(document)
		if document:IsCommandBar() then
			return
		end
		const source = document:GetScript()
		-- Only the script in this user's focused editor tab counts as their edit, not a collaborator's live typing.
		if source ~= StudioService.ActiveScript then
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
