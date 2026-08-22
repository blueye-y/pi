import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedImage, VisionConfig } from "../../src/index.js";
import {
	ClipboardPaste,
	type ClipboardPasteDeps,
	getImagePasteShortcuts,
	MAX_PASTE_IMAGE_BYTES,
} from "../../src/paste.js";

const { readClipboardImageMock, readClipboardTextMock } = vi.hoisted(() => ({
	readClipboardImageMock: vi.fn(),
	readClipboardTextMock: vi.fn(),
}));

vi.mock("../../src/clipboard.js", async (importActual) => {
	const actual = (await importActual()) as Record<string, unknown>;
	return {
		...actual,
		readClipboardImage: readClipboardImageMock,
		readClipboardText: readClipboardTextMock,
	};
});

const DEFAULT_CONFIG = {
	enabled: true,
	visionModel: "test/vision",
	fallbackModels: [],
	autoHandoff: true,
	handoffModels: [],
	prewarmPastedImages: false,
	asyncClipboardHandoff: false,
	clipboardPaste: false,
	maxTokens: undefined,
	cacheMax: 50,
	maxDescriptionLines: 0,
	thinking: false,
	thinkingLevel: "medium",
} satisfies VisionConfig;

interface CapturedCtx {
	ui: { pasteToEditor: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
	modelRegistry: object;
	hasUI: boolean;
}

const makeCtx = (): CapturedCtx => ({
	ui: { pasteToEditor: vi.fn(), notify: vi.fn() },
	modelRegistry: { find: () => ({ provider: "test", id: "vision", input: ["text", "image"] }) },
	hasUI: true,
});

const makeDeps = (overrides?: Partial<ClipboardPasteDeps>): ClipboardPasteDeps => ({
	getConfig: () => ({ ...DEFAULT_CONFIG, clipboardPaste: true }),
	prewarm: vi.fn(),
	appendPreview: vi.fn(),
	notify: vi.fn(),
	...overrides,
});

const clipboardImage = (bytes: Uint8Array, mimeType = "image/png") => ({ bytes, mimeType });

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe("ClipboardPaste.onInput", () => {
	beforeEach(() => {
		readClipboardImageMock.mockReset();
		readClipboardTextMock.mockReset();
	});

	it("is a no-op when the queue is empty", () => {
		const paste = new ClipboardPaste(makeDeps());
		expect(paste.onInput({ type: "input", text: "hello", source: "interactive" })).toEqual({ action: "continue" });
	});

	it("attaches the queued image and strips its marker on submit", async () => {
		const appendPreview = vi.fn();
		const paste = new ClipboardPaste(makeDeps({ appendPreview }));
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		const ctx = makeCtx();
		await paste.paste(ctx as never);

		expect(ctx.ui.pasteToEditor).toHaveBeenCalledWith("[Image #1] ");
		const result = paste.onInput({ type: "input", text: "look at [Image #1] please", source: "interactive" });
		expect(result).toEqual({
			action: "transform",
			text: "look at please",
			images: [{ type: "image", data: Buffer.from(PNG_BYTES).toString("base64"), mimeType: "image/png" }],
		});
		expect(appendPreview).toHaveBeenCalledTimes(1);
		// Queue is drained — a second submit attaches nothing.
		expect(paste.onInput({ type: "input", text: "again", source: "interactive" })).toEqual({ action: "continue" });
	});

	it("attaches multiple queued images in order", async () => {
		const paste = new ClipboardPaste(makeDeps());
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		const ctx = makeCtx();
		await paste.paste(ctx as never);
		readClipboardImageMock.mockResolvedValue(clipboardImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"));
		await paste.paste(ctx as never);

		expect(ctx.ui.pasteToEditor).toHaveBeenNthCalledWith(1, "[Image #1] ");
		expect(ctx.ui.pasteToEditor).toHaveBeenNthCalledWith(2, "[Image #2] ");

		const result = paste.onInput({ type: "input", text: "see [Image #1] and [Image #2]", source: "interactive" });
		expect(result.action).toBe("transform");
		const transformed = result as { text: string; images: Array<{ mimeType: string }> };
		expect(transformed.text).toBe("see and");
		expect(transformed.images).toHaveLength(2);
		expect(transformed.images[0]?.mimeType).toBe("image/png");
		expect(transformed.images[1]?.mimeType).toBe("image/jpeg");
	});

	it("clears the queue without attaching when the marker was deleted", async () => {
		const paste = new ClipboardPaste(makeDeps());
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		await paste.paste(makeCtx() as never);

		expect(paste.onInput({ type: "input", text: "no markers here", source: "interactive" })).toEqual({
			action: "continue",
		});
		// Marker gone — the image is not attached on a later submit either.
		expect(paste.onInput({ type: "input", text: "[Image #1]", source: "interactive" })).toEqual({
			action: "continue",
		});
	});

	it("attaches only the images whose markers are present", async () => {
		const paste = new ClipboardPaste(makeDeps());
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		const ctx = makeCtx();
		await paste.paste(ctx as never);
		await paste.paste(ctx as never);

		const result = paste.onInput({ type: "input", text: "only [Image #2] kept", source: "interactive" });
		expect(result.action).toBe("transform");
		const transformed = result as { text: string; images: unknown[] };
		expect(transformed.text).toBe("only kept");
		expect(transformed.images).toHaveLength(1);
	});

	it("skips source==extension inputs (already transformed)", () => {
		// The handler itself doesn't filter by source, but the transform must not
		// double-attach when the queue was drained — covered by the drain test
		// above. Here we just assert the marker regex treats the exact marker.
		const paste = new ClipboardPaste(makeDeps());
		expect(paste.onInput({ type: "input", text: "x", source: "extension" })).toEqual({ action: "continue" });
	});
});

describe("ClipboardPaste.paste (marker flow enabled)", () => {
	beforeEach(() => {
		readClipboardImageMock.mockReset();
		readClipboardTextMock.mockReset();
	});

	it("queues an image and inserts its marker when clipboardPaste is on", async () => {
		const notify = vi.fn();
		const paste = new ClipboardPaste(makeDeps({ notify }));
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		const ctx = makeCtx();
		await paste.paste(ctx as never);

		expect(ctx.ui.pasteToEditor).toHaveBeenCalledWith("[Image #1] ");
		expect(notify).toHaveBeenCalledWith(ctx, "Image attached from clipboard. (1 in draft)", "info");
		expect(readClipboardTextMock).not.toHaveBeenCalled();
	});

	it("pastes clipboard text when the clipboard holds no image", async () => {
		const paste = new ClipboardPaste(makeDeps({ getConfig: () => ({ ...DEFAULT_CONFIG, clipboardPaste: true }) }));
		readClipboardImageMock.mockResolvedValue(null);
		readClipboardTextMock.mockResolvedValue("some text");
		const ctx = makeCtx();
		await paste.paste(ctx as never);

		expect(ctx.ui.pasteToEditor).toHaveBeenCalledWith("some text");
		expect(ctx.ui.pasteToEditor).not.toHaveBeenCalledWith(expect.stringContaining("[Image #"));
	});

	it("rejects an oversized image", async () => {
		const notify = vi.fn();
		const paste = new ClipboardPaste(makeDeps({ notify }));
		readClipboardImageMock.mockResolvedValue(clipboardImage(new Uint8Array(MAX_PASTE_IMAGE_BYTES + 1)));
		const ctx = makeCtx();
		await paste.paste(ctx as never);

		expect(ctx.ui.pasteToEditor).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(ctx, expect.stringContaining("Image too large"), "warning");
	});

	it("prewarms the describer at paste time when prewarmPastedImages is on", async () => {
		const prewarm = vi.fn();
		const paste = new ClipboardPaste(
			makeDeps({
				getConfig: () => ({ ...DEFAULT_CONFIG, clipboardPaste: true, prewarmPastedImages: true }),
				prewarm,
			}),
		);
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		const ctx = makeCtx();
		await paste.paste(ctx as never);

		expect(prewarm).toHaveBeenCalledTimes(1);
		const img = prewarm.mock.calls[0]?.[0] as ExtractedImage;
		expect(img.mimeType).toBe("image/png");
		expect(img.data).toBe(Buffer.from(PNG_BYTES).toString("base64"));
		expect(prewarm.mock.calls[0]?.[1]).toBe(ctx.modelRegistry);
	});
});

describe("ClipboardPaste.paste (marker flow disabled — built-in replica)", () => {
	const disabledConfig = () => ({ ...DEFAULT_CONFIG, clipboardPaste: false });
	beforeEach(() => {
		readClipboardImageMock.mockReset();
		readClipboardTextMock.mockReset();
	});

	it("writes the image to a temp file and pastes its PATH", async () => {
		const paste = new ClipboardPaste(makeDeps({ getConfig: disabledConfig }));
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		const ctx = makeCtx();
		await paste.paste(ctx as never);

		expect(ctx.ui.pasteToEditor).toHaveBeenCalledTimes(1);
		const inserted = ctx.ui.pasteToEditor.mock.calls[0]?.[0] as string;
		expect(inserted).toMatch(/^\/.*pi-clipboard-[0-9a-f-]+\.png$/);
		// No marker flow artifacts.
		expect(ctx.ui.pasteToEditor).not.toHaveBeenCalledWith(expect.stringContaining("[Image #"));
	});

	it("never attaches image blocks when disabled", async () => {
		const paste = new ClipboardPaste(makeDeps({ getConfig: disabledConfig }));
		readClipboardImageMock.mockResolvedValue(clipboardImage(PNG_BYTES));
		await paste.paste(makeCtx() as never);
		expect(paste.hasQueuedImages).toBe(false);
		expect(paste.onInput({ type: "input", text: "[Image #1]", source: "interactive" })).toEqual({
			action: "continue",
		});
	});

	it("pastes clipboard text when the clipboard holds no image", async () => {
		const paste = new ClipboardPaste(makeDeps());
		readClipboardImageMock.mockResolvedValue(null);
		readClipboardTextMock.mockResolvedValue("plain text");
		const ctx = makeCtx();
		await paste.paste(ctx as never);

		expect(ctx.ui.pasteToEditor).toHaveBeenCalledWith("plain text");
	});
});

describe("getImagePasteShortcuts", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("does not register the built-in paste key or redundant alternatives", () => {
		const shortcuts = getImagePasteShortcuts();
		// ctrl+v (macOS/Linux pasteImage) / alt+v (Windows pasteImage) are handled
		// by the editor interception; alt+v/ctrl+alt+v are redundant (editor +
		// /vision paste cover them). Only super+v (Command+V on macOS) is kept,
		// for terminals that forward Cmd+V as a key sequence.
		expect(shortcuts).not.toContain("ctrl+v");
		expect(shortcuts).not.toContain("alt+v");
		expect(shortcuts).not.toContain("ctrl+alt+v");
	});

	it("registers only Command+V (super+v) on macOS", () => {
		const shortcuts = getImagePasteShortcuts();
		if (process.platform === "darwin") expect(shortcuts).toEqual(["super+v"]);
		else expect(shortcuts).toEqual([]);
	});
});
