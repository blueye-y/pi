/**
 * Marker-based clipboard paste (integrated from @pi-archimedes/image-paste).
 *
 * pi's built-in `ctrl+v` paste writes the clipboard image to a temp file and
 * inserts the file PATH as text, which the agent must then `read` before the
 * handoff can describe it. This capability replaces that flow when enabled
 * (`VisionConfig.clipboardPaste`): the paste shortcut reads the
 * clipboard image DIRECTLY, inserts a `[Image #N]` marker in the editor, and
 * the `input` (submit) handler replaces the markers with REAL image blocks on
 * the message. Those blocks then flow through pi-vision's existing
 * `before_agent_start` prewarm and `context` swap exactly like any other
 * attached image — no temp file, no read-tool dependency, no path text noise.
 *
 * The shortcuts are registered by the wiring layer ONLY when `clipboardPaste`
 * is on (see vision.ts): registering ctrl+v otherwise would override
 * pi's built-in paste-image keybinding and surface an "Extension shortcut
 * conflict" warning on every install. So with the feature off, ctrl+v stays
 * pi's own built-in paste (image → temp file path), which the path-based
 * prewarm already handles. The built-in replica in {@link ClipboardPaste.paste}
 * covers the short window after a mid-session `/vision paste off`
 * before a reload unregisters the shortcuts.
 *
 * Markers are STRIPPED from the submitted text (unlike image-paste, which
 * leaves them in): the `context` hook replaces the attached image block with
 * its description, so a leftover `[Image #1]` token would be pure noise in
 * the model's context.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InputEvent, InputEventResult, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { extensionForImageMimeType, readClipboardImage, readClipboardText } from "./clipboard.js";
import type { ExtractedImage, VisionConfig } from "./index.js";

/** Cap on a pasted clipboard image, matching image-paste (20MB). */
export const MAX_PASTE_IMAGE_BYTES = 20 * 1024 * 1024;

export interface PendingPasteImage {
	/** UUID — unique per paste operation. */
	id: string;
	/** The image bytes as base64 + MIME, ready to attach as an image block. */
	image: ExtractedImage;
	/** The visible marker text, e.g. "[Image #1] ". */
	marker: string;
	/** 1-based insertion order (the N in "[Image #N]"). */
	index: number;
}

export interface ClipboardPasteDeps {
	/** Live config — read on every shortcut/input, so toggles take effect instantly. */
	getConfig: () => VisionConfig;
	/** Paste-time prewarm: fire-and-forget description of a just-pasted image.
	 *  Called only when `prewarmPastedImages` is on and the active model is a
	 *  handoff target (the caller gates with `shouldPrewarmPaste()`), so the
	 *  vision call starts while the user types instead of at submit. */
	prewarm: (img: ExtractedImage, modelRegistry: ModelRegistry) => void;
	/** Persist a preview entry (rendered inline in the TUI via the registered
	 *  entry renderer; never sent to the LLM). */
	appendPreview: (images: ExtractedImage[]) => void;
	/** Notify the user (info/warning). */
	notify: (ctx: PasteContext, message: string, level?: "info" | "warning" | "error") => void;
}

/** The subset of {@link ExtensionContext} the paste flow needs. Kept minimal
 *  so the paste key can be intercepted from BOTH the shortcut handler (real
 *  ctx) and the editor wrapper (a small adapter that inserts at the cursor
 *  instead of going through ctx.ui.pasteToEditor). */
export interface PasteContext {
	ui: {
		/** Insert text at the cursor (marker, or pasted clipboard text). */
		pasteToEditor(text: string): void;
		/** Show a user notification. */
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
	modelRegistry: ModelRegistry;
	hasUI: boolean;
}

/** The keys registered as extension shortcuts. The platform paste key
 *  (app.clipboard.pasteImage: ctrl+v on non-Windows, alt+v on Windows) is
 *  deliberately NOT registered — it is intercepted in the editor wrapper
 *  (prewarm-editor.ts) instead, so pi never reports an "Extension shortcut
 *  conflict" for it. The non-standard alt+v / ctrl+alt+v are also dropped
 *  (redundant: the editor intercepts the real paste key, and /vision paste
 *  is the command fallback when the editor wrapper isn't active). The only
 *  registered key is super+v (Command+V on macOS) — the sole path for
 *  Cmd+V when a terminal forwards it as a key sequence (kitty /
 *  modifyOtherKeys); terminals that consume Cmd+V for their own paste never
 *  deliver it. */
export function getImagePasteShortcuts(): KeyId[] {
	if (process.platform !== "darwin") return [];
	return ["super+v"];
}

/** Strip the `[Image #N] ` marker text (and trailing space) from a prompt. */
/** Strip the `[Image #N] ` markers from a prompt: first the full marker text
 *  (with its trailing space), then the bare key — for markers that landed at
 *  end-of-line or right before punctuation, where no trailing space exists.
 *  Trailing whitespace left by a stripped marker is trimmed. */
function stripMarkers(text: string, markers: readonly string[]): string {
	let cleaned = text;
	for (const marker of markers) {
		const key = marker.trim();
		cleaned = cleaned.split(marker).join("").split(key).join("");
	}
	return cleaned.trim();
}

export class ClipboardPaste {
	private readonly deps: ClipboardPasteDeps;
	private queue: PendingPasteImage[] = [];
	private nextIndex = 1;
	private pasting = false;

	constructor(deps: ClipboardPasteDeps) {
		this.deps = deps;
	}

	/** Whether any pasted image is queued (markers pending in the editor). */
	get hasQueuedImages(): boolean {
		return this.queue.length > 0;
	}

	/** Reset the queue (called on session_start / session_shutdown). */
	reset(): void {
		this.queue = [];
		this.nextIndex = 1;
		this.pasting = false;
	}

	/** The paste handler (shortcut or editor-intercepted paste key).
	 *  Marker-based when `clipboardPaste` is on; otherwise replicates pi's
	 *  built-in paste (temp file + path, text fallback). */
	async paste(ctx: PasteContext): Promise<void> {
		if (this.pasting) return; // Mutex: prevent concurrent paste operations.
		this.pasting = true;
		try {
			const image = await readClipboardImage();
			if (image) {
				if (this.deps.getConfig().clipboardPaste) {
					this.queueImage(ctx, image, ctx.modelRegistry);
				} else {
					this.pasteAsTempFilePath(ctx, image);
				}
				return;
			}
			// No image on the clipboard: fall back to pasting text, exactly like
			// pi's built-in paste. The warning makes the fallback visible (without
			// it a failed image read looks like a silent "only text" paste).
			const text = await readClipboardText();
			if (text) {
				ctx.ui.pasteToEditor(text);
				this.deps.notify(ctx, "No image found in clipboard — pasted text instead.", "warning");
				return;
			}
			this.deps.notify(ctx, "No image or text found in clipboard.", "warning");
		} catch (error) {
			const msg = error instanceof Error ? error.message : "Unknown error";
			this.deps.notify(ctx, `Clipboard paste failed: ${msg}`, "warning");
		} finally {
			this.pasting = false;
		}
	}

	/** The `input` (submit) handler: attach queued images whose markers are
	 *  present in the text, strip those markers, and clear the queue. */
	onInput(event: InputEvent): InputEventResult {
		if (this.queue.length === 0) return { action: "continue" };

		const present = this.queue.filter((entry) => event.text.includes(entry.marker.trim()));
		if (present.length === 0) {
			// No markers found — the user removed them. Clear the queue.
			this.reset();
			return { action: "continue" };
		}

		const imagesToAttach = present.map((entry) => entry.image);
		const cleaned = stripMarkers(
			event.text,
			present.map((entry) => entry.marker),
		);
		this.reset();

		if (imagesToAttach.length === 0) return { action: "continue" };
		this.deps.appendPreview(imagesToAttach);

		return {
			action: "transform",
			text: cleaned,
			images: imagesToAttach.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
		};
	}

	// ── Internals ──────────────────────────────────────────────────────────

	/** Queue the image, insert its marker in the editor, and (opt-in) prewarm
	 *  the describer so the vision call starts at paste time. */
	private queueImage(
		ctx: PasteContext,
		image: { bytes: Uint8Array; mimeType: string },
		modelRegistry: ModelRegistry,
	): void {
		if (image.bytes.length > MAX_PASTE_IMAGE_BYTES) {
			this.deps.notify(
				ctx,
				`Image too large (${(image.bytes.length / 1024 / 1024).toFixed(1)}MB > 20MB).`,
				"warning",
			);
			return;
		}
		const id = randomUUID();
		const marker = `[Image #${this.nextIndex}] `;
		const extracted: ExtractedImage = {
			data: Buffer.from(image.bytes).toString("base64"),
			mimeType: image.mimeType,
		};
		this.queue.push({ id, image: extracted, marker, index: this.nextIndex });
		this.nextIndex += 1;
		ctx.ui.pasteToEditor(marker);
		this.deps.notify(ctx, `Image attached from clipboard. (${this.queue.length} in draft)`, "info");
		if (this.deps.getConfig().prewarmPastedImages) {
			this.deps.prewarm(extracted, modelRegistry);
		}
	}

	/** Replicate pi's built-in paste when the marker flow is off: write the
	 *  image to a temp file and insert the PATH, so pi-vision's existing
	 *  path-based prewarm keeps working. */
	private pasteAsTempFilePath(ctx: PasteContext, image: { bytes: Uint8Array; mimeType: string }): void {
		const ext = extensionForImageMimeType(image.mimeType) ?? "png";
		const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
		try {
			writeFileSync(filePath, Buffer.from(image.bytes));
		} catch {
			// Ignore clipboard errors, like pi's built-in paste.
			return;
		}
		ctx.ui.pasteToEditor(filePath);
	}
}
