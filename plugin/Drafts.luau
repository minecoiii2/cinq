const Constants = require(script.Parent.Constants)
const Source = require(script.Parent.Source)

-- Plugins can't read the version a draft started from, so Cinq records it when it sees a draft start (an edit to a
-- script that matched its committed source). Bases are saved in plugin settings by sync id to survive restarts; a
-- draft that started while Cinq wasn't watching has no base, since guessing one could revert someone's commit.
const committed: { [LuaSourceContainer]: string } = setmetatable({}, { __mode = "k" }) :: any
const clean: { [LuaSourceContainer]: boolean } = setmetatable({}, { __mode = "k" }) :: any
local saved: { [string]: string } = {}
local store: Plugin? = nil
local settingKey = ""

const Drafts = {}

const function idOf(instance: LuaSourceContainer): string?
	const id = instance:GetAttribute(Constants.IdAttribute)
	return if type(id) == "string" then id else nil
end

const function setBase(instance: LuaSourceContainer, base: string?)
	const id = idOf(instance)
	if not id or saved[id] == base then
		return
	end
	saved[id] = base
	if store then
		store:SetSetting(settingKey, saved)
	end
end

const function refresh(instance: LuaSourceContainer)
	const draft = Source.read(instance)
	if draft == committed[instance] then
		clean[instance] = true
		setBase(instance, nil)
	elseif clean[instance] then
		clean[instance] = false
		if Drafts.baseOf(instance) == nil then
			setBase(instance, committed[instance])
		end
	end
end

function Drafts.load(pluginObject: Plugin, key: string)
	store = pluginObject
	settingKey = key
	const stored = pluginObject:GetSetting(key)
	saved = if type(stored) == "table" then stored else {}
end

function Drafts.track(instance: LuaSourceContainer)
	if committed[instance] ~= nil then
		return
	end
	committed[instance] = Source.normalize((instance :: any).Source)
	clean[instance] = false
	refresh(instance)
end

function Drafts.onEdited(instance: LuaSourceContainer)
	if committed[instance] ~= nil then
		refresh(instance)
	end
end

function Drafts.onCommitted(instance: LuaSourceContainer)
	committed[instance] = Source.normalize((instance :: any).Source)
	if Source.read(instance) == committed[instance] then
		clean[instance] = true
		setBase(instance, nil)
	end
end

function Drafts.isTracked(instance: LuaSourceContainer): boolean
	return committed[instance] ~= nil
end

function Drafts.baseOf(instance: LuaSourceContainer): string?
	const id = idOf(instance)
	return if id then saved[id] else nil
end

-- After Cinq merges the latest commit into a draft, that commit is what the draft is now based on.
function Drafts.rebase(instance: LuaSourceContainer)
	setBase(instance, Source.normalize((instance :: any).Source))
end

function Drafts.forget(instance: LuaSourceContainer)
	setBase(instance, nil)
end

return Drafts
