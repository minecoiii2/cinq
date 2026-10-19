const StudioService = game:GetService("StudioService")

return {
	Url = "http://localhost:34877",
	Services = {
		"ReplicatedStorage",
		"ReplicatedFirst",
		"ServerScriptService",
		"ServerStorage",
		"StarterPlayer",
		"StarterGui",
		"StarterPack",
		"Lighting",
		"SoundService",
	},
	IgnoreTag = "Cinq_Ignore",
	-- Per user so collaborators running Cinq on the same place never overwrite each other's ids.
	IdAttribute = `CinqId_{StudioService:GetUserId()}`,
	LegacyIdAttribute = "CinqId",
	UserId = StudioService:GetUserId(),
	EditorAttribute = "CinqEditedBy",
	EditorHashAttribute = "CinqEditedHash",
	SnapshotChunkBytes = 1_000_000,
	EventIntervalSeconds = 3,
}
