# Experimental image and table blocks

This local prototype keeps the extension's native heading decorations and displays standalone local images and GFM tables in reserved editor insets. Images and tables occupy real vertical space, so the following paragraph stays below the preview. It uses VS Code's proposed `editorInsets` API and is intended for development testing, not a normal Marketplace release.

## Try it

From this checkout:

```sh
npm ci
npm run bundle
code --profile "Markdown Block Prototype" --extensionDevelopmentPath="$PWD" --enable-proposed-api=CodeSmith.markdown-inline-editor-vscode --new-window "$PWD/docs/block-preview-demo.md"
```

In the development window, run **Markdown Inline Editor: Toggle Experimental Image and Table Blocks** from the Command Palette, or use its preview icon in the editor title bar. The toggle applies to the current file for the current extension-host session. It does not install an extension into the normal profile or write editor preferences.

For daily use, set `markdownInlineEditor.experimental.autoEnable` to `true` to enable previews automatically when Markdown files open. The preview button can still turn them off for a file during that session. An installed VSIX needs `"enable-proposed-api": ["CodeSmith.markdown-inline-editor-vscode"]` in VS Code's runtime `argv.json`, followed by a full application restart. Keep existing runtime arguments and editor theme settings intact.

The existing eye icon still controls ordinary Markdown decorations. Block previews are a separate opt-in prototype. If ordinary decorations are turned off, moving the selection reconciles block previews with that state.

## Images

Standalone local PNG, JPEG, GIF, WebP, and SVG links render below their source line. The existing styled alt text remains above the image. The preview reads a bounded local file and embeds its bytes; it does not fetch remote images. Missing, unsupported, external, and oversized images produce an explanation instead of covering text. The current size limit is 8 MB.

Use **Edit source** to return to the image line. Moving the cursor outside that source restores the preview. Embedded images in prose, lists, and blockquotes are excluded from this first version.

## Tables

The table source folds to a summary while its HTML preview is visible. Cells wrap independently, with a minimum overall table width that keeps columns readable. Use the arrow buttons or the table's own horizontal scroll area to reach the remaining columns. Tall tables scroll inside the preview. Up to 200 data rows are rendered; the complete source remains available.

Use **Edit source** or place the cursor in the source range to expand the Markdown and remove the preview. Moving outside restores the rendered table. This uses native folding ranges and does not replace text or insert blank lines. On a table already folded by the user, the prototype cannot distinguish its own fold from that prior state; toggling previews off can unfold that table.

## Current limits

- `editorInsets` is experimental and needs the launch flag. An upstream release must resolve the dependency on a proposed API before treating this as a normal feature.
- Insets use fixed reserved heights because the proposed API has no height setter. A bounded frame avoids repeated webview recreation, which the current native disposal implementation does not fully clean up. Long table content scrolls within that frame; shorter content can leave extra space.
- The inset's native width can follow the document's longest line rather than the visible pane. `markdownInlineEditor.experimental.blockWidth` therefore defaults to 560 pixels. Reduce it for a narrow split pane or increase it for a wide editor. Automatic pane-width tracking is not solved.
- Image frames are reserved from the image's aspect ratio at `blockWidth` (dimensions read from PNG, GIF, JPEG, or SVG headers; WebP and unreadable headers fall back to 18 lines). SVGs scale to fill the block width; raster images stop at their natural width. In a pane narrower than `blockWidth` the image shrinks but the reserved frame does not, leaving space below it.
- Standalone images and tables on whitespace-indented list-item continuation lines are supported; the shared indent is stripped before a table is re-parsed. Images on a list-marker line (`- ![x](y)`) and inside blockquotes are still skipped.
- This is a local-file prototype. Remote workspaces, other nested Markdown blocks, multi-editor folding restoration, and long-session webview disposal need more work before an upstream PR is ready.
- Table HTML escapes source text. It preserves basic emphasis and inline code, but cell links are displayed as text and cell images as alt text. Raw HTML is escaped.
- Document-change and selection events reuse the shared parse-cache entry. The additional block model is cached per entry; cursor movement does not parse the whole document again.

## Validation

Run `npm run validate` and `npm run lint`. The standalone extension-host runner is `src/test/e2e/block-preview-runner.ts`; it needs a workspace containing the generic `preview-demo.md` fixture used during development and the proposed API launch flag. It checks actual image loading, rendered table columns, horizontal scrolling, native heading navigation, source reveal, anchor relocation after insert/undo, font-size changes, and a clean, unchanged Markdown document after toggling off.

The development discussion is [inline image rendering #90](https://github.com/SeardnaSchmid/markdown-inline-editor-vscode/issues/90). Existing decoration-based table-preview work is described in [#136](https://github.com/SeardnaSchmid/markdown-inline-editor-vscode/pull/136); this experiment investigates block layout for cases where wrapping cannot fit into one editor line.
