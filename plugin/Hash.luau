-- 32-bit FNV-1a over the UTF-8 bytes; must match fnv() in server/sync.js.
return function(text: string): string
	local hash = 2166136261
	for i = 1, #text do
		hash = bit32.bxor(hash, string.byte(text, i))
		-- hash * 16777619 split as (hash << 24) + hash * 403 so the product stays exact in a double.
		hash = (bit32.lshift(hash, 24) + hash * 403) % 4294967296
	end
	return string.format("%08x", hash)
end
