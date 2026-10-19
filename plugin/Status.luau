const Studio = settings().Studio

const PADDING = 10
const SYNCING_LINGER_SECONDS = 1.2
const CONFLICT_COLOR = Color3.fromRGB(240, 150, 40)
const DOT_COLORS = {
	live = Color3.fromRGB(70, 190, 110),
	waiting = Color3.fromRGB(230, 170, 60),
	off = Color3.fromRGB(140, 140, 140),
}
const LABELS = { live = "Live", waiting = "Waiting for the Cinq server", off = "Off" }

export type State = "live" | "waiting" | "off"

type Parts = {
	background: Frame,
	dot: Frame,
	state: TextLabel,
	syncing: TextLabel,
	size: TextLabel,
	conflicts: TextLabel,
	detail: TextLabel,
	folder: TextBox,
	toggle: TextButton,
}

local parts: Parts? = nil
local current: State = "off"
local lastPulse = 0

const Status = {}

const function color(style: Enum.StudioStyleGuideColor): Color3
	return Studio.Theme:GetColor(style)
end

const function text(parent: Instance, size: number, order: number?): TextLabel
	const label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.SourceSans
	label.TextSize = size
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.LayoutOrder = order or 0
	label.Parent = parent
	return label
end

const function chip(parent: Instance, order: number): TextLabel
	const label = text(parent, 13, order)
	label.AutomaticSize = Enum.AutomaticSize.X
	label.Size = UDim2.fromOffset(0, 18)
	label.Visible = false
	return label
end

const function formatBytes(bytes: number): string
	return if bytes < 1024 * 1024
		then `{math.max(1, math.round(bytes / 1024))} KB`
		else string.format("%.1f MB", bytes / 1024 / 1024)
end

const function repaint()
	if not parts then
		return
	end
	const dimmed = color(Enum.StudioStyleGuideColor.DimmedText)
	parts.background.BackgroundColor3 = color(Enum.StudioStyleGuideColor.MainBackground)
	parts.state.TextColor3 = color(Enum.StudioStyleGuideColor.MainText)
	parts.syncing.TextColor3 = dimmed
	parts.size.TextColor3 = dimmed
	parts.detail.TextColor3 = dimmed
	parts.conflicts.TextColor3 = CONFLICT_COLOR
	parts.conflicts.BackgroundColor3 = CONFLICT_COLOR
	parts.folder.BackgroundColor3 = color(Enum.StudioStyleGuideColor.InputFieldBackground)
	parts.folder.TextColor3 = color(Enum.StudioStyleGuideColor.MainText)
	parts.toggle.BackgroundColor3 = color(Enum.StudioStyleGuideColor.Button)
	parts.toggle.TextColor3 = color(Enum.StudioStyleGuideColor.ButtonText)
	parts.dot.BackgroundColor3 = DOT_COLORS[current]
end

function Status.init(pluginObject: Plugin, onToggle: () -> ()): DockWidgetPluginGui
	const info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 320, 150, 240, 120)
	const dock = pluginObject:CreateDockWidgetPluginGui("CinqStatus", info)
	dock.Title = "Cinq"
	dock.Name = "CinqStatus"

	const background = Instance.new("Frame")
	background.BorderSizePixel = 0
	background.Size = UDim2.fromScale(1, 1)
	background.Parent = dock
	const padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, PADDING)
	padding.PaddingRight = UDim.new(0, PADDING)
	padding.PaddingTop = UDim.new(0, PADDING)
	padding.Parent = background

	const row = Instance.new("Frame")
	row.BackgroundTransparency = 1
	row.Size = UDim2.new(1, 0, 0, 22)
	row.Parent = background
	const layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.VerticalAlignment = Enum.VerticalAlignment.Center
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 8)
	layout.Parent = row

	const dot = Instance.new("Frame")
	dot.BorderSizePixel = 0
	dot.Size = UDim2.fromOffset(10, 10)
	dot.LayoutOrder = 1
	dot.Parent = row
	const round = Instance.new("UICorner")
	round.CornerRadius = UDim.new(1, 0)
	round.Parent = dot

	const state = text(row, 18, 2)
	state.Font = Enum.Font.SourceSansSemibold
	state.AutomaticSize = Enum.AutomaticSize.X
	state.Size = UDim2.fromOffset(0, 22)

	const syncing = chip(row, 3)
	syncing.Text = "Syncing…"
	const size = chip(row, 4)
	const conflicts = chip(row, 5)
	conflicts.BackgroundTransparency = 0.82
	const pillPadding = Instance.new("UIPadding")
	pillPadding.PaddingLeft = UDim.new(0, 6)
	pillPadding.PaddingRight = UDim.new(0, 6)
	pillPadding.Parent = conflicts
	const pillRound = Instance.new("UICorner")
	pillRound.CornerRadius = UDim.new(0, 4)
	pillRound.Parent = conflicts

	const detail = text(background, 14)
	detail.TextWrapped = true
	detail.Position = UDim2.fromOffset(0, 28)
	detail.Size = UDim2.new(1, 0, 0, 18)

	const folder = Instance.new("TextBox")
	folder.BorderSizePixel = 0
	folder.ClearTextOnFocus = false
	folder.TextEditable = false
	folder.Font = Enum.Font.Code
	folder.TextSize = 13
	folder.TextXAlignment = Enum.TextXAlignment.Left
	folder.TextTruncate = Enum.TextTruncate.AtEnd
	folder.Position = UDim2.fromOffset(0, 50)
	folder.Size = UDim2.new(1, 0, 0, 22)
	folder.Parent = background
	const folderPadding = Instance.new("UIPadding")
	folderPadding.PaddingLeft = UDim.new(0, 6)
	folderPadding.PaddingRight = UDim.new(0, 6)
	folderPadding.Parent = folder

	const toggle = Instance.new("TextButton")
	toggle.BorderSizePixel = 0
	toggle.Font = Enum.Font.SourceSans
	toggle.TextSize = 15
	toggle.Position = UDim2.fromOffset(0, 82)
	toggle.Size = UDim2.fromOffset(100, 24)
	toggle.Parent = background
	toggle.Activated:Connect(onToggle)

	parts = {
		background = background,
		dot = dot,
		state = state,
		syncing = syncing,
		size = size,
		conflicts = conflicts,
		detail = detail,
		folder = folder,
		toggle = toggle,
	}
	Studio.ThemeChanged:Connect(repaint)
	Status.set("off")
	return dock
end

function Status.set(state: State, folder: string?)
	current = state
	if not parts then
		return
	end
	const live = state == "live"
	parts.state.Text = LABELS[state]
	parts.detail.Text = if live
		then "Syncing this place's scripts into:"
		elseif state == "waiting" then "Start it with cinq start; this place reconnects on its own."
		else "Not syncing. Connect to mirror this place's scripts to files."
	parts.folder.Visible = live and folder ~= nil
	parts.folder.Text = folder or ""
	parts.toggle.Text = if state == "off" then "Connect" else "Disconnect"
	if not live then
		parts.syncing.Visible = false
		parts.size.Visible = false
		parts.conflicts.Visible = false
	end
	repaint()
end

-- Shows "Syncing…" for a moment after each batch, so quick syncs don't flicker.
function Status.pulse()
	if not parts or current ~= "live" then
		return
	end
	lastPulse = os.clock()
	parts.syncing.Visible = true
	task.delay(SYNCING_LINGER_SECONDS, function()
		if parts and os.clock() - lastPulse >= SYNCING_LINGER_SECONDS - 0.05 then
			parts.syncing.Visible = false
		end
	end)
end

function Status.setInfo(bytes: number?, conflictCount: number?)
	if not parts or current ~= "live" then
		return
	end
	parts.size.Visible = bytes ~= nil
	parts.size.Text = if bytes then formatBytes(bytes) else ""
	const count = conflictCount or 0
	parts.conflicts.Visible = count > 0
	parts.conflicts.Text = `⚠ {count} conflict{if count == 1 then "" else "s"}`
end

return Status
