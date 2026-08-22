/**
 * Inline TUI preview for images attached via the marker-based clipboard paste.
 *
 * Integrated from @pi-archimedes/image-paste's preview renderer. pi's TUI does
 * not render image content in user messages, so without this the user would
 * get no visual feedback that an image was attached. The preview is persisted
 * as a CUSTOM ENTRY (`pi.appendEntry` + `registerEntryRenderer`), not a custom
 * message: entries never participate in LLM context, so the preview's image
 * blocks can't leak into the payload (where the `context` hook would describe
 * them a second time, duplicating the description the transform already
 * attached to the user message).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";

import type { ExtractedImage } from "./index.js";

/** Entry type under which pasted-image previews are persisted. */
export const PASTE_PREVIEW_ENTRY_TYPE = "vision-paste-preview";

export interface PastePreviewData {
	images: ExtractedImage[];
}

/** Register the entry renderer that draws pasted images inline (collapsed row
 *  by default, Ctrl+O to expand — same convention as the async-handoff row). */
export function registerPastePreviewEntryRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<PastePreviewData>(PASTE_PREVIEW_ENTRY_TYPE, (entry, { expanded }, theme) => {
		try {
			const images = entry.data?.images;
			if (!Array.isArray(images) || images.length === 0) return undefined;
			const count = images.length;
			const hint = expanded ? "Ctrl+O to collapse" : "Ctrl+O to expand";
			const summary = theme.fg("dim", `📷 Image pasted · ${count} image${count === 1 ? "" : "s"} · ${hint}`);
			if (!expanded) return new Text(summary, 0, 0);
			const container = new Container();
			container.addChild(new Text(summary, 0, 0));
			for (const img of images) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Image(
						img.data,
						img.mimeType,
						{ fallbackColor: (text) => theme.fg("toolOutput", text) },
						{ maxWidthCells: 60 },
					),
				);
			}
			return container;
		} catch {
			return undefined;
		}
	});
}
