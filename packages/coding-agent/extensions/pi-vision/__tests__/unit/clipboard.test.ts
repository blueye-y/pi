import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	downloadImage,
	extensionForImageMimeType,
	extractImageUrlFromHtml,
	isWaylandSession,
	readClipboardImage,
	readClipboardText,
} from "../../src/clipboard.js";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("node:child_process", async (importActual) => {
	const actual = (await importActual()) as Record<string, unknown>;
	return {
		...actual,
		spawnSync: spawnSyncMock,
	};
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const spawnResult = (stdout: Buffer | string, status = 0, error?: NodeJS.ErrnoException) => ({
	stdout,
	status,
	error,
});

describe("isWaylandSession", () => {
	it("detects WAYLAND_DISPLAY", () => {
		expect(isWaylandSession({ WAYLAND_DISPLAY: ":0" })).toBe(true);
	});

	it("detects XDG_SESSION_TYPE=wayland", () => {
		expect(isWaylandSession({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
	});

	it("returns false for X11 or headless", () => {
		expect(isWaylandSession({ DISPLAY: ":0" })).toBe(false);
		expect(isWaylandSession({})).toBe(false);
	});
});

describe("extensionForImageMimeType", () => {
	it("maps the supported formats", () => {
		expect(extensionForImageMimeType("image/png")).toBe("png");
		expect(extensionForImageMimeType("image/jpeg")).toBe("jpg");
		expect(extensionForImageMimeType("image/webp")).toBe("webp");
		expect(extensionForImageMimeType("image/gif")).toBe("gif");
	});

	it("normalizes parameters and case", () => {
		expect(extensionForImageMimeType("image/PNG; charset=utf-8")).toBe("png");
	});

	it("rejects unsupported formats", () => {
		expect(extensionForImageMimeType("image/bmp")).toBeNull();
		expect(extensionForImageMimeType("application/pdf")).toBeNull();
	});
});

describe("readClipboardImage via wl-paste (Wayland)", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
		// Un-mocked calls (e.g. the xclip fallthrough after a null wl-paste) yield
		// empty stdout instead of crashing on an undefined result.
		spawnSyncMock.mockImplementation(() => spawnResult(Buffer.alloc(0)));
	});

	it("reads the preferred image MIME from the clipboard", async () => {
		spawnSyncMock
			.mockImplementationOnce(() => spawnResult(Buffer.from("text/plain\nimage/png\n")))
			.mockImplementationOnce(() => spawnResult(PNG_BYTES));

		const image = await readClipboardImage({
			platform: "linux",
			environment: { WAYLAND_DISPLAY: ":0" },
		});

		expect(image).not.toBeNull();
		expect(image!.mimeType).toBe("image/png");
		expect(Buffer.from(image!.bytes)).toEqual(PNG_BYTES);
		// list-types then data, with --no-newline
		expect(spawnSyncMock).toHaveBeenNthCalledWith(1, "wl-paste", ["--list-types"], expect.anything());
		expect(spawnSyncMock).toHaveBeenNthCalledWith(
			2,
			"wl-paste",
			["--type", "image/png", "--no-newline"],
			expect.anything(),
		);
	});

	it("prefers a supported type over an unrelated image/* type", async () => {
		spawnSyncMock
			.mockImplementationOnce(() => spawnResult(Buffer.from("image/tiff\nimage/webp\n")))
			.mockImplementationOnce(() => spawnResult(PNG_BYTES));

		const image = await readClipboardImage({
			platform: "linux",
			environment: { WAYLAND_DISPLAY: ":0" },
		});
		expect(image?.mimeType).toBe("image/webp");
	});

	it("returns null when the clipboard advertises no image", async () => {
		spawnSyncMock.mockImplementationOnce(() => spawnResult(Buffer.from("text/plain\n")));
		const image = await readClipboardImage({
			platform: "linux",
			environment: { WAYLAND_DISPLAY: ":0" },
		});
		expect(image).toBeNull();
	});

	it("returns null when wl-paste is missing (falls through to no reader)", async () => {
		spawnSyncMock.mockImplementationOnce(() =>
			spawnResult(Buffer.alloc(0), 0, { code: "ENOENT" } as NodeJS.ErrnoException),
		);
		const image = await readClipboardImage({
			platform: "linux",
			environment: { WAYLAND_DISPLAY: ":0" },
		});
		expect(image).toBeNull();
	});

	it("rejects an unsupported image MIME (e.g. BMP from WSLg)", async () => {
		spawnSyncMock
			.mockImplementationOnce(() => spawnResult(Buffer.from("image/bmp\n")))
			.mockImplementationOnce(() => spawnResult(PNG_BYTES));

		const image = await readClipboardImage({
			platform: "linux",
			environment: { WAYLAND_DISPLAY: ":0" },
		});
		expect(image).toBeNull();
	});
});

describe("readClipboardText", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
	});

	it("reads text via wl-paste on Wayland", async () => {
		spawnSyncMock.mockImplementationOnce(() => spawnResult(Buffer.from("hello clipboard")));
		const text = await readClipboardText({
			platform: "linux",
			environment: { WAYLAND_DISPLAY: ":0" },
		});
		expect(text).toBe("hello clipboard");
	});
});

describe("extractImageUrlFromHtml", () => {
	it("extracts the img src (not the later auth-requiring data-src)", () => {
		const html = `<img src="https://my.feishu.cn/space/api/box/stream/download/asynccode/?code=abc&amp;token=xyz" data-single-block="tr" data-ace-gallery-json="{&quot;items&quot;:[{&quot;src&quot;:&quot;https%3A%2F%2Finternal.example%2Fx&quot;}]}" data-src="https://internal.example/needs-auth" data-width="860">`;
		expect(extractImageUrlFromHtml(html)).toBe(
			"https://my.feishu.cn/space/api/box/stream/download/asynccode/?code=abc&token=xyz",
		);
	});

	it("falls back to the gallery-json src when no img src exists", () => {
		const html = `<div data-type="image" data-ace-gallery-json="{&quot;items&quot;:[{&quot;uuid&quot;:&quot;u1&quot;,&quot;src&quot;:&quot;https%3A%2F%2Finternal.example%2Fdownload%2Fimg.png&quot;}]}">`;
		expect(extractImageUrlFromHtml(html)).toBe("https://internal.example/download/img.png");
	});

	it("returns an embedded data: URL as-is", () => {
		const html = `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">`;
		expect(extractImageUrlFromHtml(html)).toBe(
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		);
	});

	it("ignores srcset and returns null for text-only HTML", () => {
		const html = `<img srcset="/a.png 1x" alt="x"><p>hello</p>`;
		expect(extractImageUrlFromHtml(html)).toBeNull();
		expect(extractImageUrlFromHtml("<p>just text</p>")).toBeNull();
	});
});

describe("downloadImage", () => {
	it("fetches an embedded data: URL and sniffs the mime type", async () => {
		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const img = await downloadImage(`data:image/png;base64,${pngBase64}`);
		expect(img).not.toBeNull();
		expect(img!.mimeType).toBe("image/png");
		expect(Buffer.from(img!.bytes).toString("base64")).toBe(pngBase64);
	});

	it("rejects a non-image data URL", async () => {
		const img = await downloadImage("data:text/plain;base64,aGVsbG8=" /* hello */);
		expect(img).toBeNull();
	});
});
