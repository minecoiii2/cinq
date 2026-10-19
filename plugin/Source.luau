const ScriptEditorService = game:GetService("ScriptEditorService")

-- Scripts loaded from a place file can contain CRLF, but UpdateSourceAsync always stores LF, so Cinq works in LF only.
const function normalize(text: string): string
	return (string.gsub(text, "\r\n", "\n"))
end

return {
	normalize = normalize,
	read = function(instance: Instance): string
		return normalize(ScriptEditorService:GetEditorSource(instance :: LuaSourceContainer))
	end,
}
