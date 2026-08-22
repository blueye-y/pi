/**
 * Cross-platform clipboard image/text reading for the marker-based paste
 * capability (integrated from @pi-archimedes/image-paste's clipboard reader).
 *
 * pi-vision's existing pasted-image flow depends on pi's built-in `ctrl+v`
 * paste, which writes the clipboard image to a temp file and inserts the file
 * PATH as text. That path must then be `read` by the agent, and the read tool
 * must successfully process it (Photon resize, etc.) before the handoff can
 * describe it. This module adds the missing capability: reading the clipboard
 * image DIRECTLY, so the paste handler can attach the image as a real image
 * block on submit — no temp file, no read-tool dependency.
 *
 * Reader strategy (per platform), matching both image-paste and pi core:
 *   - native: `@mariozechner/clipboard` (pi ships it as a dependency, so it
 *     resolves in any pi install) — loaded lazily via createRequire with a
 *     try/catch so a missing module degrades to the CLI readers.
 *   - linux/Wayland: `wl-paste` (list-types → preferred image MIME → data).
 *   - linux/X11: `xclip` (TARGETS → preferred image MIME → data).
 *   - win32: PowerShell (System.Windows.Forms Clipboard → PNG base64).
 *   - WSL: `wl-paste`/`xclip` first, then PowerShell into the Windows
 *     clipboard (Windows screenshots land there, not in the Linux clipboard).
 *
 * MIME support is aligned with pi-vision's image sniff (png/jpeg/webp/gif),
 * so an image attached via the marker flow is described by the same vision
 * pipeline as a read-tool image. Unsupported formats (e.g. BMP from WSLg) are
 * rejected here — the vision models pi-vision targets accept the same set.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sniffImageMime } from "./image.js";

const LIST_TYPES_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: string;
}

export interface ClipboardReadOptions {
	environment?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}

interface ClipboardModule {
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number> | Uint8Array>;
	getText?: () => Promise<string>;
}

let cachedClipboardModule: ClipboardModule | null | undefined;

const requireFromHere = createRequire(import.meta.url);

function loadClipboardNative(): ClipboardModule | null {
	if (cachedClipboardModule !== undefined) return cachedClipboardModule;
	try {
		cachedClipboardModule = requireFromHere("@mariozechner/clipboard") as ClipboardModule;
	} catch {
		cachedClipboardModule = null;
	}
	return cachedClipboardModule;
}

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
	return "code" in error;
}

function hasGraphicalSession(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): boolean {
	return platform !== "linux" || Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

export function isWaylandSession(environment: NodeJS.ProcessEnv): boolean {
	return Boolean(environment.WAYLAND_DISPLAY) || environment.XDG_SESSION_TYPE === "wayland";
}

function isWSL(environment: NodeJS.ProcessEnv): boolean {
	if (environment.WSL_DISTRO_NAME || environment.WSLENV) return true;
	try {
		const release = readFileSync("/proc/version", "utf8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

/** Normalize a MIME type to its base form (strip parameters, lowercase). */
function normalizeMimeType(mimeType: string): string {
	return baseMimeType(mimeType);
}

function selectPreferredImageMimeType(mimeTypes: readonly string[]): string | null {
	const normalized = mimeTypes
		.map((m) => m.trim())
		.filter((m) => m.length > 0)
		.map((m) => ({ raw: m, base: baseMimeType(m) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((m) => m.base === preferred);
		if (match) return match.raw;
	}
	const firstImage = normalized.find((m) => m.base.startsWith("image/"));
	return firstImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === baseMimeType(mimeType));
}

interface CommandResult {
	ok: boolean;
	stdout: Buffer;
	missingCommand: boolean;
}

function runCommand(command: string, args: string[], timeout: number): CommandResult {
	const result = spawnSync(command, args, { timeout, maxBuffer: MAX_BUFFER_BYTES });
	if (result.error) {
		return {
			ok: false,
			stdout: Buffer.alloc(0),
			missingCommand: isErrnoException(result.error) && result.error.code === "ENOENT",
		};
	}
	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf8" : undefined);
	return { ok: result.status === 0, stdout, missingCommand: false };
}

// ── Per-platform readers ────────────────────────────────────────────────────

async function readViaNativeModule(): Promise<ClipboardImage | null> {
	const clipboard = loadClipboardNative();
	if (!clipboard || !clipboard.hasImage()) return null;
	const imageData = await clipboard.getImageBinary();
	if (!imageData || imageData.length === 0) return null;
	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
	return { bytes, mimeType: "image/png" };
}

function readViaWlPaste(): ClipboardImage | null {
	const listTypes = runCommand("wl-paste", ["--list-types"], LIST_TYPES_TIMEOUT_MS);
	if (listTypes.missingCommand || !listTypes.ok) return null;
	const mimeTypes = listTypes.stdout
		.toString("utf8")
		.split(/\r?\n/)
		.map((m) => m.trim())
		.filter((m) => m.length > 0);
	const selected = selectPreferredImageMimeType(mimeTypes);
	if (!selected) return null;
	const data = runCommand("wl-paste", ["--type", selected, "--no-newline"], READ_TIMEOUT_MS);
	if (!data.ok || data.stdout.length === 0) return null;
	return { bytes: new Uint8Array(data.stdout), mimeType: normalizeMimeType(selected) };
}

function readViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], LIST_TYPES_TIMEOUT_MS);
	if (targets.missingCommand) return null;
	const advertised = targets.ok
		? targets.stdout
				.toString("utf8")
				.split(/\r?\n/)
				.map((m) => m.trim())
				.filter((m) => m.length > 0)
		: [];
	const preferred = advertised.length > 0 ? selectPreferredImageMimeType(advertised) : null;
	const mimeTypesToTry = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];
	for (const mimeType of mimeTypesToTry) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"], READ_TIMEOUT_MS);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: new Uint8Array(data.stdout), mimeType: normalizeMimeType(mimeType) };
		}
	}
	return null;
}

function encodePowerShell(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/** Read the clipboard image via Windows PowerShell (win32). Base64 over stdout. */
function readViaPowerShell(): Promise<ClipboardImage | null> {
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { return }
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { return }
$stream = New-Object System.IO.MemoryStream
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [System.Convert]::ToBase64String($stream.ToArray())
} finally {
  $stream.Dispose()
  $image.Dispose()
}
`;
	return new Promise((resolve) => {
		const child = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-STA",
				"-EncodedCommand",
				encodePowerShell(script),
			],
			{ windowsHide: true },
		);
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(null);
		}, READ_TIMEOUT_MS);
		let stdout = "";
		let exceededMaxBuffer = false;
		child.stdout?.on("data", (data: Buffer) => {
			if (stdout.length + data.length > MAX_BUFFER_BYTES) {
				exceededMaxBuffer = true;
				return;
			}
			stdout += data.toString("utf8");
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
		child.on("close", (status: number | null) => {
			clearTimeout(timeout);
			if (status !== 0 || exceededMaxBuffer) {
				resolve(null);
				return;
			}
			const base64 = stdout.trim();
			if (!base64) {
				resolve(null);
				return;
			}
			try {
				const bytes = Buffer.from(base64, "base64");
				resolve(bytes.length > 0 ? { bytes: new Uint8Array(bytes), mimeType: "image/png" } : null);
			} catch {
				resolve(null);
			}
		});
	});
}

/** The JXA script that reads the first image from the macOS pasteboard and
 *  prints `<utitype>:<base64>` (or `NO_IMAGE:<types>`). Bypasses the native
 *  clipboard module entirely — osascript reads the NSPasteboard directly, so
 *  this keeps working when @mariozechner/clipboard is missing or its native
 *  binary fails to load (ABI mismatch). PNG is preferred; TIFF/JPEG fall
 *  back to whatever the pasteboard offers. The `bytes()` bridging is avoided
 *  (it throws in some JXA versions); base64 is taken straight off NSData. */
const OSASCRIPT_READ_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const pb = $.NSPasteboard.generalPasteboard;
const types = [];
const n = pb.types.count;
for (let i = 0; i < n; i++) types.push(ObjC.unwrap(pb.types.objectAtIndex(i)));
function b64Of(d) {
  if (!d || d.isNil()) return null;
  return ObjC.unwrap(d.base64EncodedStringWithOptions(0));
}
let out = 'NO_IMAGE:' + types.join(',');
if (types.includes('public.png')) {
  const b = b64Of(pb.dataForType('public.png'));
  if (b) out = 'public.png:' + b;
} else if (types.includes('public.jpeg')) {
  const b = b64Of(pb.dataForType('public.jpeg'));
  if (b) out = 'public.jpeg:' + b;
} else if (types.includes('public.tiff')) {
  const b = b64Of(pb.dataForType('public.tiff'));
  if (b) out = 'public.tiff:' + b;
}
out;
`;

const OSASCRIPT_TIMEOUT_MS = 10_000;

/** Read the clipboard image on macOS via osascript (JXA → NSPasteboard).
 *  Returns null when the pasteboard holds no image or osascript fails. */
function readViaOsascript(): Promise<ClipboardImage | null> {
	return new Promise((resolve) => {
		const child = spawn("osascript", ["-l", "JavaScript", "-e", OSASCRIPT_READ_SCRIPT]);
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(null);
		}, OSASCRIPT_TIMEOUT_MS);
		let stdout = "";
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString("utf8");
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
		child.on("close", (status: number | null) => {
			clearTimeout(timeout);
			if (status !== 0) {
				resolve(null);
				return;
			}
			const line = stdout.trim();
			const colon = line.indexOf(":");
			if (colon <= 0) {
				resolve(null);
				return;
			}
			const type = line.slice(0, colon);
			const base64 = line.slice(colon + 1);
			if (!type.startsWith("public.") || !base64) {
				resolve(null);
				return;
			}
			try {
				const bytes = Buffer.from(base64, "base64");
				if (bytes.length === 0) {
					resolve(null);
					return;
				}
				resolve({ bytes: new Uint8Array(bytes), mimeType: mimeForUtType(type) });
			} catch {
				resolve(null);
			}
		});
	});
}

function mimeForUtType(type: string): string {
	switch (type) {
		case "public.png":
			return "image/png";
		case "public.jpeg":
			return "image/jpeg";
		case "public.tiff":
			return "image/tiff";
		default:
			return `image/${type.replace("public.", "").replaceAll("-", "")}`;
	}
}

/** Convert a clipboard image to a supported format (PNG) using macOS's
 *  built-in `sips` — handles TIFF (the default image type macOS puts on the
 *  pasteboard) and any other unsupported format. Returns null on failure. */
function convertViaSips(bytes: Uint8Array, sourceType: string): ClipboardImage | null {
	const ext = sourceType === "image/tiff" ? "tiff" : "bin";
	const inFile = join(tmpdir(), `pi-vision-clip-${randomUUID()}.${ext}`);
	const outFile = join(tmpdir(), `pi-vision-clip-${randomUUID()}.png`);
	try {
		writeFileSync(inFile, Buffer.from(bytes));
		const result = spawnSync("sips", ["-s", "format", "png", inFile, "--out", outFile], {
			timeout: READ_TIMEOUT_MS,
		});
		if (result.status !== 0 || !existsSync(outFile)) return null;
		const converted = readFileSync(outFile);
		return converted.length > 0 ? { bytes: new Uint8Array(converted), mimeType: "image/png" } : null;
	} catch {
		return null;
	} finally {
		for (const f of [inFile, outFile]) {
			try {
				unlinkSync(f);
			} catch {
				// Ignore cleanup errors.
			}
		}
	}
}

// ── HTML-clipboard image extraction (Feishu docs, WebKit apps, …) ──────────

/** The JXA script that prints the pasteboard's HTML representation (or empty). */
const OSASCRIPT_HTML_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const pb = $.NSPasteboard.generalPasteboard;
const d = pb.dataForType('public.html');
if (d && !d.isNil()) ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding));
else '';
`;

/** Read the pasteboard's HTML representation on macOS (empty string when absent). */
function readHtmlFromPasteboard(): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn("osascript", ["-l", "JavaScript", "-e", OSASCRIPT_HTML_SCRIPT]);
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve("");
		}, OSASCRIPT_TIMEOUT_MS);
		let stdout = "";
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString("utf8");
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve("");
		});
		child.on("close", (status: number | null) => {
			clearTimeout(timeout);
			resolve(status === 0 ? stdout : "");
		});
	});
}

/** Decode the HTML entities that appear inside clipboard HTML attribute
 *  values (`&amp;`, `&quot;`, `&#39;`, `&lt;`, `&gt;`, `&nbsp;`). */
function decodeHtmlEntities(text: string): string {
	return text
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&nbsp;", " ");
}

/** Extract the first image reference from an HTML clipboard representation.
 *  Handles `<img src>` (the signed download URL Feishu docs puts there),
 *  embedded `data:image` URLs, and Feishu's `data-ace-gallery-json` items[]
 *  `src` fields (URL-encoded). The src regex uses a lazy attribute boundary
 *  so `data-src`/`srcset` attributes are NOT matched (Feishu's img tag
 *  carries an auth-requiring `data-src` AFTER the working `src`). Returns
 *  null when no image is referenced. */
export function extractImageUrlFromHtml(html: string): string | null {
	// Embedded data: URLs need no download.
	const dataUrl = /<img[^>]*?(?:\s|["'])src\s*=\s*"(data:image\/[^;"]+;base64,[A-Za-z0-9+/=]+)"/i.exec(html);
	if (dataUrl?.[1]) return dataUrl[1];

	// <img src="https://…"> — the signed asynccode URL Feishu uses. Runs on
	// the RAW html (entities intact) so the attribute value stays delimited.
	const imgSrc = /<img[^>]*?(?:\s|["'])src\s*=\s*"(https?:\/\/[^"]+)"/i.exec(html);
	if (imgSrc?.[1]) return decodeHtmlEntities(imgSrc[1]);

	// Feishu docs: data-ace-gallery-json="{... items:[{ src: '…' }] ...}"
	// (raw attribute value keeps &quot; entities, so [^"]+ spans it).
	const gallery = /data-ace-gallery-json\s*=\s*"([^"]+)"/i.exec(html);
	if (gallery?.[1]) {
		try {
			const data = JSON.parse(decodeHtmlEntities(gallery[1])) as { items?: Array<{ src?: unknown }> };
			for (const item of data.items ?? []) {
				if (typeof item.src === "string" && item.src) return decodeURIComponent(item.src);
			}
		} catch {
			// Malformed gallery JSON — fall through.
		}
	}

	return null;
}

/** Cap on a downloaded HTML-referenced image. */
const MAX_HTML_IMAGE_BYTES = 20 * 1024 * 1024;

/** Download an image URL extracted from an HTML clipboard representation.
 *  Verifies the response is actually an image (magic bytes) and within the
 *  size cap. Returns null on any failure. */
export async function downloadImage(url: string): Promise<ClipboardImage | null> {
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0" },
			signal: AbortSignal.timeout(READ_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType && !contentType.startsWith("image/")) return null;
		const buf = Buffer.from(await response.arrayBuffer());
		if (buf.length === 0 || buf.length > MAX_HTML_IMAGE_BYTES) return null;
		const mimeType = sniffImageMime(buf);
		if (!mimeType) return null;
		return { bytes: new Uint8Array(buf), mimeType };
	} catch {
		return null;
	}
}
/** Read the clipboard image via Windows PowerShell from WSL (the Windows
 *  clipboard holds Win+Shift+S screenshots; the Linux clipboard does not). */
async function readViaWslPowerShell(): Promise<ClipboardImage | null> {
	const { randomUUID } = await import("node:crypto");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { existsSync, readFileSync, unlinkSync } = await import("node:fs");
	const tmpFile = join(tmpdir(), `pi-vision-wsl-clip-${randomUUID()}.png`);
	try {
		const winPath = runCommand("wslpath", ["-w", tmpFile], LIST_TYPES_TIMEOUT_MS);
		if (!winPath.ok) return null;
		const quoted = winPath.stdout.toString("utf8").trim().replaceAll("'", "''");
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${quoted}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");
		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", script], READ_TIMEOUT_MS);
		if (!result.ok || result.stdout.toString("utf8").trim() !== "ok") return null;
		const bytes = readFileSync(tmpFile);
		return bytes.length > 0 ? { bytes: new Uint8Array(bytes), mimeType: "image/png" } : null;
	} catch {
		return null;
	} finally {
		try {
			if (existsSync(tmpFile)) unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Read the clipboard image, trying each available reader for the platform.
 *  Returns null when the clipboard holds no image (or no reader is usable), or
 *  when the image format is outside the supported set (png/jpeg/webp/gif). */
export async function readClipboardImage(options?: ClipboardReadOptions): Promise<ClipboardImage | null> {
	const image = await readClipboardImageUnchecked(options);
	if (image && !isSupportedImageMimeType(image.mimeType)) return null;
	return image;
}

async function readClipboardImageUnchecked(options?: ClipboardReadOptions): Promise<ClipboardImage | null> {
	const environment = options?.environment ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (environment.TERMUX_VERSION) return null;
	if (!hasGraphicalSession(platform, environment)) return null;

	if (platform === "win32") {
		const nativeImage = await readViaNativeModule();
		if (nativeImage) return nativeImage;
		return readViaPowerShell();
	}

	if (platform === "linux") {
		const wsl = isWSL(environment);
		const wayland = isWaylandSession(environment);
		if (wayland || wsl) {
			const image = readViaWlPaste() ?? readViaXclip();
			if (image) return image;
		}
		if (wsl) {
			const wslImage = await readViaWslPowerShell();
			if (wslImage) return wslImage;
		}
		if (!wayland) {
			const nativeImage = await readViaNativeModule();
			if (nativeImage) return nativeImage;
		}
		return readViaXclip();
	}
	// macOS: native module first (fast when its binary loads), then the
	// osascript/JXA reader (no native deps — keeps paste working when the
	// module is missing or its binary fails to load). TIFF (the default image
	// type macOS puts on the pasteboard) is converted to PNG via sips. When
	// neither finds a pasteboard image type, fall back to the HTML clipboard
	// representation (Feishu docs & WebKit apps copy images as HTML with a
	// signed download URL, not as image types): extract the URL and download it.
	const nativeImage = await readViaNativeModule();
	if (nativeImage) return nativeImage;
	const jxaImage = await readViaOsascript();
	if (jxaImage) {
		if (isSupportedImageMimeType(jxaImage.mimeType)) return jxaImage;
		return convertViaSips(jxaImage.bytes, jxaImage.mimeType);
	}
	const html = await readHtmlFromPasteboard();
	if (html) {
		const url = extractImageUrlFromHtml(html);
		if (url) {
			const downloaded = await downloadImage(url);
			if (downloaded) return downloaded;
		}
	}
	return null;
}

/** Read plain text from the clipboard (native module, then wl-paste/xclip on
 *  Linux). Used by the paste handler's text fallback, mirroring pi's built-in
 *  `ctrl+v` behaviour (paste text when the clipboard holds no image). */
export async function readClipboardText(options?: ClipboardReadOptions): Promise<string | null> {
	const environment = options?.environment ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (platform === "linux" && !environment.TERMUX_VERSION) {
		if (isWaylandSession(environment)) {
			const result = runCommand("wl-paste", ["--no-newline", "--type", "text"], READ_TIMEOUT_MS);
			if (result.ok && result.stdout.length > 0) return result.stdout.toString("utf8");
		}
		const result = runCommand("xclip", ["-selection", "clipboard", "-o"], READ_TIMEOUT_MS);
		if (result.ok && result.stdout.length > 0) return result.stdout.toString("utf8");
	}

	const clipboard = loadClipboardNative();
	if (!clipboard?.getText) return null;
	try {
		const text = await clipboard.getText();
		return text || null;
	} catch {
		return null;
	}
}

/** Map a (normalized) image MIME type to its file extension, or null when
 *  unsupported. Used by the built-in-paste replica to name temp files exactly
 *  like pi's `handleClipboardPaste` (`pi-clipboard-<uuid>.<ext>`), so the
 *  existing path-based prewarm keeps matching. */
export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}
