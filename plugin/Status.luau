const Studio = settings().Studio

const PADDING = 10
const DOT_COLORS = {
	live = Color3.fromRGB(70, 190, 110),
	waiting = Color3.fromRGB(230, 170, 60),
	off = Color3.fromRGB(140, 140, 140),
}
const LABELS = { live = "Live", waiting = "Waiting for the Cinq server", off = "Off" }

export type State = "live" | "waiting" | "off"

local dot: Frame? = nil
local stateLabel: TextLabel? = nil
local detailLabel: TextLabel? = nil
local folderBox: TextBox? = nil
local toggleButton: TextButton? = nil
local background: Frame? = nil
local current: State = "off"

const Status = {}

const function color(style: Enum.StudioStyleGuideColor): Color3
	return Studio.Theme:GetColor(style)
end

const function text(parent: Instance, size: number, y: number): TextLabel
	const label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.SourceSans
	label.TextSize = size
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextWrapped = true
	label.AutomaticSize = Enum.AutomaticSize.Y
	label.Position = UDim2.fromOffset(0, y)
	label.Size = UDim2.new(1, 0, 0, size + 4)
	label.Parent = parent
	return label
end

const function repaint()
	if not background or not stateLabel or not detailLabel or not folderBox or not toggleButton or not dot then
		return
	end
	background.BackgroundColor3 = color(Enum.StudioStyleGuideColor.MainBackground)
	stateLabel.TextColor3 = color(Enum.StudioStyleGuideColor.MainText)
	detailLabel.TextColor3 = color(Enum.StudioStyleGuideColor.DimmedText)
	folderBox.BackgroundColor3 = color(Enum.StudioStyleGuideColor.InputFieldBackground)
	folderBox.TextColor3 = color(Enum.StudioStyleGuideColor.MainText)
	toggleButton.BackgroundColor3 = color(Enum.StudioStyleGuideColor.Button)
	toggleButton.TextColor3 = color(Enum.StudioStyleGuideColor.ButtonText)
	dot.BackgroundColor3 = DOT_COLORS[current]
end

function Status.init(pluginObject: Plugin, onToggle: () -> ()): DockWidgetPluginGui
	const info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 300, 150, 220, 120)
	const dock = pluginObject:CreateDockWidgetPluginGui("CinqStatus", info)
	dock.Title = "Cinq"
	dock.Name = "CinqStatus"

	const frame = Instance.new("Frame")
	frame.BorderSizePixel = 0
	frame.Size = UDim2.fromScale(1, 1)
	frame.Parent = dock
	const padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, PADDING)
	padding.PaddingRight = UDim.new(0, PADDING)
	padding.PaddingTop = UDim.new(0, PADDING)
	padding.Parent = frame

	const indicator = Instance.new("Frame")
	indicator.BorderSizePixel = 0
	indicator.Size = UDim2.fromOffset(10, 10)
	indicator.Position = UDim2.fromOffset(0, 6)
	indicator.Parent = frame
	const round = Instance.new("UICorner")
	round.CornerRadius = UDim.new(1, 0)
	round.Parent = indicator

	const state = text(frame, 18, 0)
	state.Position = UDim2.fromOffset(18, 0)
	state.Size = UDim2.new(1, -18, 0, 22)
	state.Font = Enum.Font.SourceSansSemibold
	const detail = text(frame, 14, 28)

	const box = Instance.new("TextBox")
	box.BorderSizePixel = 0
	box.ClearTextOnFocus = false
	box.TextEditable = false
	box.Font = Enum.Font.Code
	box.TextSize = 13
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.TextTruncate = Enum.TextTruncate.AtEnd
	box.Position = UDim2.fromOffset(0, 48)
	box.Size = UDim2.new(1, 0, 0, 22)
	box.Parent = frame
	const boxPadding = Instance.new("UIPadding")
	boxPadding.PaddingLeft = UDim.new(0, 6)
	boxPadding.PaddingRight = UDim.new(0, 6)
	boxPadding.Parent = box

	const button = Instance.new("TextButton")
	button.BorderSizePixel = 0
	button.Font = Enum.Font.SourceSans
	button.TextSize = 15
	button.Position = UDim2.fromOffset(0, 80)
	button.Size = UDim2.fromOffset(100, 24)
	button.Parent = frame
	button.Activated:Connect(onToggle)

	background, dot, stateLabel, detailLabel, folderBox, toggleButton = frame, indicator, state, detail, box, button
	Studio.ThemeChanged:Connect(repaint)
	Status.set("off")
	return dock
end

function Status.set(state: State, folder: string?)
	current = state
	if not stateLabel or not detailLabel or not folderBox or not toggleButton then
		return
	end
	stateLabel.Text = LABELS[state]
	detailLabel.Text = if state == "live"
		then "Syncing this place's scripts into:"
		elseif state == "waiting" then "Start it with cinq start; this place reconnects on its own."
		else "Not syncing. Connect to mirror this place's scripts to files."
	folderBox.Visible = state == "live" and folder ~= nil
	folderBox.Text = folder or ""
	toggleButton.Text = if state == "off" then "Connect" else "Disconnect"
	repaint()
end

return Status
