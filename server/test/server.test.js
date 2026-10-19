"use strict"

const test = require("node:test")
const assert = require("node:assert")
const { isLocalRequest } = require("../index")

test("Studio and CLI requests to localhost are allowed", () => {
	assert.ok(isLocalRequest({ host: "localhost:34877" }))
	assert.ok(isLocalRequest({ host: "127.0.0.1:34877" }))
	assert.ok(isLocalRequest({ host: "[::1]:34877" }))
	assert.ok(isLocalRequest({ host: "LocalHost" }))
})

test("browser requests are refused", () => {
	assert.ok(!isLocalRequest({ host: "localhost:34877", origin: "https://evil.example" }))
	assert.ok(!isLocalRequest({ host: "localhost:34877", origin: "null" }))
	assert.ok(!isLocalRequest({ host: "localhost:34877", origin: "http://localhost:3000" }))
})

test("DNS rebinding and missing hosts are refused", () => {
	assert.ok(!isLocalRequest({ host: "evil.example:34877" }))
	assert.ok(!isLocalRequest({ host: "localhost.evil.example" }))
	assert.ok(!isLocalRequest({}))
})
