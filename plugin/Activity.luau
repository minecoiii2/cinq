const ScriptEditorService = game:GetService("ScriptEditorService")
const Selection = game:GetService("Selection")

const Studio = settings().Studio

const MAX_ENTRIES = 100
const ROW_HEIGHT = 40
const HEADER_HEIGHT = 28
const LABELS = { disk = "From disk", conflict = "Conflict", problem = "Refused" }

export type Entry = { kind: string, path: string?, detail: string, instance: Instance?, line: number? }
type Row = { button: TextButton, title: TextLabel, detail: TextLabel, kind: string, hovered: boolean }

local list: ScrollingFrame? = nil
local header: Frame? = nil
local headerTitle: TextLabel? = nil
local clearButton: TextButton? = nil
local emptyLabel: TextLabel? = nil
local counter = 0
local rows: { Row } = {}

const Activity = {}

const function color(style: Enum.StudioStyleGuideColor, modifier: Enum.StudioStyleGuideModifier?): Color3
	return Studio.Theme:GetColor(style, modifier or Enum.StudioStyleGuideModifier.Default)
end

const function label(parent: Instance, size: number, position: UDim2, height: number): TextLabel
	const text = Instance.new("TextLabel")
	text.BackgroundTransparency = 1
	text.Font = Enum.Font.SourceSans
	text.TextSize = size
	text.TextXAlignment = Enum.TextXAlignment.Left
	text.TextTruncate = Enum.TextTruncate.AtEnd
	text.Position = position
	text.Size = UDim2.new(1, 0, 0, height)
	text.Parent = parent
	return text
end

const function paint(row: Row)
	const modifier = if row.hovered then Enum.StudioStyleGuideModifier.Hover else Enum.StudioStyleGuideModifier.Default
	row.button.BackgroundColor3 = color(Enum.StudioStyleGuideColor.Item, modifier)
	row.title.TextColor3 = color(Enum.StudioStyleGuideColor.MainText)
	row.detail.TextColor3 = if row.kind == "conflict"
		then color(Enum.StudioStyleGuideColor.WarningText)
		elseif row.kind == "problem" then color(Enum.StudioStyleGuideColor.ErrorText)
		else color(Enum.StudioStyleGuideColor.DimmedText)
end

const function repaint()
	if not list or not header or not headerTitle or not clearButton or not emptyLabel then
		return
	end
	list.BackgroundColor3 = color(Enum.StudioStyleGuideColor.MainBackground)
	list.ScrollBarImageColor3 = color(Enum.StudioStyleGuideColor.ScrollBar)
	header.BackgroundColor3 = color(Enum.StudioStyleGuideColor.Titlebar)
	headerTitle.TextColor3 = color(Enum.StudioStyleGuideColor.TitlebarText)
	clearButton.BackgroundColor3 = color(Enum.StudioStyleGuideColor.Button)
	clearButton.TextColor3 = color(Enum.StudioStyleGuideColor.ButtonText)
	emptyLabel.TextColor3 = color(Enum.StudioStyleGuideColor.DimmedText)
	for _, row in rows do
		paint(row)
	end
end

const function reveal(instance: Instance?, line: number?)
	if not instance or not instance:IsDescendantOf(game) then
		return
	end
	if not instance:IsA("LuaSourceContainer") then
		Selection:Set({ instance })
		return
	end
	task.spawn(function()
		const ok = ScriptEditorService:OpenScriptDocumentAsync(instance)
		const document = if ok then ScriptEditorService:FindScriptDocument(instance) else nil
		if document and line then
			document:RequestSetSelectionAsync(math.min(line, document:GetLineCount()), 1)
		end
	end)
end

const function clear()
	for _, row in rows do
		row.button:Destroy()
	end
	rows = {}
	if emptyLabel then
		emptyLabel.Visible = true
	end
end

function Activity.init(pluginObject: Plugin): DockWidgetPluginGui
	const info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 320, 220, 160)
	const dock = pluginObject:CreateDockWidgetPluginGui("CinqActivity", info)
	dock.Title = "Cinq Activity"
	dock.Name = "CinqActivity"

	const top = Instance.new("Frame")
	top.BorderSizePixel = 0
	top.Size = UDim2.new(1, 0, 0, HEADER_HEIGHT)
	top.Parent = dock
	const title = label(top, 15, UDim2.fromOffset(8, 0), HEADER_HEIGHT)
	title.Size = UDim2.new(1, -80, 0, HEADER_HEIGHT)
	title.Text = "Changes from disk"
	const clearAll = Instance.new("TextButton")
	clearAll.AnchorPoint = Vector2.new(1, 0.5)
	clearAll.Position = UDim2.new(1, -6, 0.5, 0)
	clearAll.Size = UDim2.fromOffset(56, 20)
	clearAll.BorderSizePixel = 0
	clearAll.Font = Enum.Font.SourceSans
	clearAll.TextSize = 14
	clearAll.Text = "Clear"
	clearAll.Parent = top
	clearAll.Activated:Connect(clear)

	const scroller = Instance.new("ScrollingFrame")
	scroller.BorderSizePixel = 0
	scroller.Position = UDim2.fromOffset(0, HEADER_HEIGHT)
	scroller.Size = UDim2.new(1, 0, 1, -HEADER_HEIGHT)
	scroller.CanvasSize = UDim2.new()
	scroller.AutomaticCanvasSize = Enum.AutomaticSize.Y
	scroller.ScrollBarThickness = 6
	scroller.Parent = dock
	const layout = Instance.new("UIListLayout")
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 1)
	layout.Parent = scroller

	const empty = label(scroller, 14, UDim2.fromOffset(8, 8), 40)
	empty.TextWrapped = true
	empty.TextTruncate = Enum.TextTruncate.None
	empty.Size = UDim2.new(1, -16, 0, 40)
	empty.LayoutOrder = math.huge
	empty.Text = "Files changed on disk, conflicts and refused changes show up here. Click one to open it."

	list, header, headerTitle, clearButton, emptyLabel = scroller, top, title, clearAll, empty
	Studio.ThemeChanged:Connect(repaint)
	repaint()
	return dock
end

function Activity.add(entry: Entry)
	if not list then
		return
	end
	counter += 1
	const button = Instance.new("TextButton")
	button.AutoButtonColor = false
	button.BorderSizePixel = 0
	button.Text = ""
	button.Size = UDim2.new(1, 0, 0, ROW_HEIGHT)
	button.LayoutOrder = -counter
	const padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, 8)
	padding.PaddingRight = UDim.new(0, 8)
	padding.PaddingTop = UDim.new(0, 3)
	padding.Parent = button
	const title = label(button, 15, UDim2.new(), 18)
	title.Text = entry.path or "?"
	const detail = label(button, 14, UDim2.fromOffset(0, 18), 16)
	detail.Text = `{LABELS[entry.kind] or entry.kind} · {entry.detail} · {os.date("%H:%M")}`
	button.Parent = list

	const row: Row = { button = button, title = title, detail = detail, kind = entry.kind, hovered = false }
	button.MouseEnter:Connect(function()
		row.hovered = true
		paint(row)
	end)
	button.MouseLeave:Connect(function()
		row.hovered = false
		paint(row)
	end)
	button.Activated:Connect(function()
		reveal(entry.instance, entry.line)
	end)
	table.insert(rows, row)
	paint(row)
	if #rows > MAX_ENTRIES then
		table.remove(rows, 1).button:Destroy()
	end
	if emptyLabel then
		emptyLabel.Visible = false
	end
end

return Activity
