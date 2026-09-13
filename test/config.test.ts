import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyWorkerOverride,
	DEFAULT_CONFIG,
	isLocalRef,
	parseConfig,
	splitModelRef,
	withWorkerOverride,
} from "../src/config.ts";

test("no flags leave the configured worker alone", () => {
	assert.equal(applyWorkerOverride("ollama/qwen3.8-27b", undefined, undefined), "ollama/qwen3.8-27b");
	assert.equal(applyWorkerOverride("inherit", "", ""), "inherit");
});

test("a fully qualified --model decides both halves", () => {
	assert.equal(applyWorkerOverride("ollama/qwen3.8-27b", undefined, "openai-codex/gpt-5.6-terra"), "openai-codex/gpt-5.6-terra");
	// An explicit prefix on --model wins over --provider rather than producing a
	// reference that mixes the two.
	assert.equal(applyWorkerOverride("inherit", "ollama", "openai-codex/gpt-5.6-terra"), "openai-codex/gpt-5.6-terra");
});

test("half an override keeps the other half from the config", () => {
	assert.equal(applyWorkerOverride("openai-codex/gpt-5.6-terra", undefined, "gpt-5.6-luna"), "openai-codex/gpt-5.6-luna");
	assert.equal(applyWorkerOverride("openai-codex/gpt-5.6-terra", "ollama", undefined), "ollama/gpt-5.6-terra");
});

test("overriding half of an inherited worker falls back to the built-in default", () => {
	// "inherit" names no provider and no model, so there is nothing to merge into.
	const { provider, model } = splitModelRef(DEFAULT_CONFIG.models.worker);
	assert.equal(applyWorkerOverride("inherit", undefined, "gpt-5.6-luna"), `${provider}/gpt-5.6-luna`);
	assert.equal(applyWorkerOverride("inherit", "ollama", undefined), `ollama/${model}`);
});

test("withWorkerOverride returns the original config when nothing changed", () => {
	const config = parseConfig('[models]\nworker = "ollama/qwen3.8-27b"\n');
	assert.equal(withWorkerOverride(config, undefined, undefined), config);
	const overridden = withWorkerOverride(config, undefined, "gpt-5.6-terra");
	assert.equal(overridden.models.worker, "ollama/gpt-5.6-terra");
	// The untouched halves come along, and the original is not mutated.
	assert.equal(overridden.models.verifier, config.models.verifier);
	assert.equal(config.models.worker, "ollama/qwen3.8-27b");
});

test("a bare reference is an ollama tag, a prefixed one is not", () => {
	assert.equal(isLocalRef("qwen3.8-27b:52k"), true);
	assert.equal(isLocalRef("ollama/qwen3.8-27b"), true);
	assert.equal(isLocalRef("openai-codex/gpt-5.6-terra"), false);
});
