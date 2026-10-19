if not plugin then
	return
end

const RunService = game:GetService("RunService")
if not RunService:IsEdit() then
	return
end

const HttpService = game:GetService("HttpService")

const Activity = require(script.Parent.Activity)
const Drafts = require(script.Parent.Drafts)
const Http = require(script.Parent.Http)
const Session = require(script.Parent.Session)

-- Unpublished places all have PlaceId 0, so they're remembered by name; dots in setting keys don't persist.
const PLACE_KEY = if game.PlaceId ~= 0 then tostring(game.PlaceId) else `0:{string.gsub(game.Name, "%.", "_")}`
const AUTOCONNECT_SETTING = `autoconnect:{PLACE_KEY}`
Drafts.load(plugin, `drafts:{PLACE_KEY}`)

const toolbar = plugin:CreateToolbar("Cinq")
const button = toolbar:CreateButton("CinqSync", "Sync this place's scripts with the Cinq server", "", "Cinq")
button.ClickableWhenViewportHidden = true
const sizeButton = toolbar:CreateButton("CinqSize", "Print how much disk space this place's Cinq folder uses", "", "Size")
sizeButton.ClickableWhenViewportHidden = true
const activityButton = toolbar:CreateButton("CinqActivity", "Show changes from disk, conflicts and refused changes", "", "Activity")
activityButton.ClickableWhenViewportHidden = true

const activity = Activity.init(plugin)
activityButton:SetActive(activity.Enabled)
activityButton.Click:Connect(function()
	activity.Enabled = not activity.Enabled
end)
activity:GetPropertyChangedSignal("Enabled"):Connect(function()
	activityButton:SetActive(activity.Enabled)
end)

sizeButton.Click:Connect(function()
	sizeButton:SetActive(false)
	const query = `placeId={game.PlaceId}&placeName={HttpService:UrlEncode(Session.placeName())}`
	const ok, status, body = pcall(Http.request, "GET", `/size?{query}`)
	if not ok or status ~= 200 or not body then
		warn("[Cinq] Couldn't reach the Cinq server to measure the folder")
	elseif body.files == 0 then
		print(`[Cinq] Nothing synced for this place yet ({body.dir})`)
	else
		print(string.format("[Cinq] %s uses %.2f MB (%d files)", body.dir, body.bytes / 1024 / 1024, body.files))
	end
end)

local session = nil

const function onStatus(status: string, isProblem: boolean)
	if isProblem then
		warn(`[Cinq] {status}`)
	else
		print(`[Cinq] {status}`)
	end
end

const function start()
	session = Session.new(onStatus)
	session:start()
	button:SetActive(true)
	plugin:SetSetting(AUTOCONNECT_SETTING, true)
end

const function stop()
	if session then
		session:stop()
	end
	session = nil
	button:SetActive(false)
	plugin:SetSetting(AUTOCONNECT_SETTING, false)
end

button.Click:Connect(function()
	if session then
		stop()
	else
		start()
	end
end)

plugin.Unloading:Connect(function()
	if session then
		session:stop()
	end
end)

-- Older versions stored one shared "autoconnect:0" for every unpublished place.
if game.PlaceId == 0 and plugin:GetSetting(AUTOCONNECT_SETTING) == nil and plugin:GetSetting("autoconnect:0") then
	plugin:SetSetting("autoconnect:0", nil)
	start()
elseif plugin:GetSetting(AUTOCONNECT_SETTING) then
	start()
end
