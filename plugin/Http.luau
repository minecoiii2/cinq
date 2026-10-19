const HttpService = game:GetService("HttpService")

const Constants = require(script.Parent.Constants)

const Http = {}

function Http.request(method: string, path: string, body: any?): (number, any)
	const response = HttpService:RequestAsync({
		Url = Constants.Url .. path,
		Method = method,
		Headers = { ["Content-Type"] = "application/json" },
		Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
	})
	const ok, decoded = pcall(HttpService.JSONDecode, HttpService, response.Body)
	return response.StatusCode, if ok then decoded else nil
end

return Http
