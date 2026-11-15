import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Decorator } from '../decorator';
import { isEditorInDiffView } from '../diff-context';
import { isSupportedMarkdownLanguage, FILE_BACKED_MARKDOWN_SELECTOR } from '../language-support';
import { resolveImageTarget } from '../link-targets';
import type { MarkdownParseCache, ParseEntry } from '../markdown-parse-cache';
import { renderBlockHtml } from './html';
import { escapeHtml, extractPreviewBlocks, measuredInsetLines, renderTable, type PreviewBlock } from './model';

type Preview = {
  block: PreviewBlock;
  inset: vscode.WebviewEditorInset;
  height: number;
  version: number;
  ready?: boolean;
  contentHeight?: number;
  columns?: number;
  clientWidth?: number;
  scrollWidth?: number;
  scrollLeft?: number;
};

/** Session-only experimental block previews. Never writes to documents or preferences. */
export class BlockPreviewController implements vscode.Disposable {
  private readonly enabledUris = new Set<string>();
  private readonly autoDisabledUris = new Set<string>();
  private readonly blocksByEntry = new WeakMap<ParseEntry, PreviewBlock[]>();
  private readonly previews = new Map<string, Preview>();
  private readonly foldedLines = new Set<number>();
  private readonly foldingChanged = new vscode.EventEmitter<void>();
  private readonly summary = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; font-size: 0;',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly subscriptions: vscode.Disposable[] = [];
  private editor: vscode.TextEditor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly cache: MarkdownParseCache, private readonly decorator: Decorator) {
    this.subscriptions.push(
      vscode.commands.registerCommand('mdInline.toggleBlockPreviews', () => this.toggle()),
      vscode.languages.registerFoldingRangeProvider(FILE_BACKED_MARKDOWN_SELECTOR, {
        onDidChangeFoldingRanges: this.foldingChanged.event,
        provideFoldingRanges: document => this.enabledUris.has(document.uri.toString())
          ? this.blocks(document).filter(b => b.kind === 'table').map(b => new vscode.FoldingRange(b.startLine, b.endLine))
          : [],
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        // Focus on an inset can temporarily leave no active text editor.
        if (editor) this.refresh();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.window.onDidChangeTextEditorSelection(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === this.editor?.document) {
          this.clearInsets();
          this.foldedLines.clear();
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('markdownInlineEditor.experimental.autoEnable')) {
          this.enabledUris.clear();
          this.autoDisabledUris.clear();
          this.refresh();
        }
        if (event.affectsConfiguration('editor.fontSize') || event.affectsConfiguration('editor.lineHeight') || event.affectsConfiguration('editor.fontFamily') || event.affectsConfiguration('markdownInlineEditor.experimental.blockWidth')) {
          this.clearInsets();
          this.refresh();
        }
      }),
    );
    this.refresh();
  }

  /** Toggle for the current file only. The proposed API is required to turn it on. */
  async toggle(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor ?? this.editor;
    if (!editor || editor.document.uri.scheme !== 'file' || !isSupportedMarkdownLanguage(editor.document.languageId)) return false;
    const uri = editor.document.uri.toString();
    if (this.enabledUris.has(uri)) {
      this.enabledUris.delete(uri);
      this.autoDisabledUris.add(uri);
      await this.restoreSource();
      this.foldingChanged.fire();
      return false;
    }
    if (typeof vscode.window.createWebviewTextEditorInset !== 'function') {
      void vscode.window.showInformationMessage('Block previews need the experimental editorInsets API. Launch the isolated development profile described in the prototype notes.');
      return false;
    }
    this.enabledUris.add(uri);
    this.autoDisabledUris.delete(uri);
    this.foldingChanged.fire();
    this.refresh();
    return true;
  }

  /** Debounced reconciliation reuses the shared parse entry on selection changes. */
  refresh(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.render(); }, 100);
  }

  /** Lightweight runtime state for extension-host integration tests. */
  get state(): { enabled: boolean; previews: { kind: string; line: number; height: number; ready: boolean; columns?: number; clientWidth?: number; scrollWidth?: number; scrollLeft?: number }[] } {
    return {
      enabled: !!this.editor && this.enabledUris.has(this.editor.document.uri.toString()),
      previews: [...this.previews.values()].map(p => ({ kind: p.block.kind, line: p.inset.line, height: p.height, ready: p.ready ?? false, columns: p.columns, clientWidth: p.clientWidth, scrollWidth: p.scrollWidth, scrollLeft: p.scrollLeft })),
    };
  }

  /** Integration-test hook for checking that columns outside the frame are reachable. */
  async scrollTablesToEnd(): Promise<void> {
    for (const preview of this.previews.values()) if (preview.block.kind === 'table') await preview.inset.webview.postMessage({ type: 'scrollTableEnd' });
  }

  private blocks(document: vscode.TextDocument): PreviewBlock[] {
    const entry = this.cache.get(document);
    let blocks = this.blocksByEntry.get(entry);
    if (!blocks) {
      blocks = extractPreviewBlocks(entry);
      this.blocksByEntry.set(entry, blocks);
    }
    return blocks;
  }

  private async render(): Promise<void> {
    const generation = ++this.generation;
    const editor = vscode.window.activeTextEditor ?? this.editor;
    if (!editor || !vscode.window.visibleTextEditors.includes(editor)) {
      this.clearInsets();
      return;
    }
    if (this.editor && editor !== this.editor) await this.restoreSource();
    this.editor = editor;
    const uri = editor.document.uri.toString();
    if (editor.document.uri.scheme === 'file' && isSupportedMarkdownLanguage(editor.document.languageId) && !this.autoDisabledUris.has(uri)
      && vscode.workspace.getConfiguration('markdownInlineEditor', editor.document).get<boolean>('experimental.autoEnable', false)) {
      this.enabledUris.add(uri);
    }
    if (!this.enabledUris.has(editor.document.uri.toString()) || !this.decorator.isEnabled() || isEditorInDiffView(editor)) {
      await this.restoreSource();
      return;
    }
    const version = editor.document.version;
    const wanted = new Set<string>();
    const renderedTables: PreviewBlock[] = [];
    const toFold: number[] = [];
    const toUnfold: number[] = [];
    const summaries: vscode.DecorationOptions[] = [];
    for (const block of this.blocks(editor.document)) {
      const key = `${block.kind}:${block.startLine}`;
      const editing = editor.selections.some(s => s.start.line <= block.endLine && s.end.line >= block.startLine);
      if (editing) {
        if (this.foldedLines.delete(block.startLine)) toUnfold.push(block.startLine);
        continue;
      }
      wanted.add(key);
      if (block.kind === 'table') {
        renderedTables.push(block);
        if (!this.foldedLines.has(block.startLine)) toFold.push(block.startLine);
        summaries.push({
          range: editor.document.lineAt(block.startLine).range,
          renderOptions: { before: {
            contentText: `Table · ${block.table.children[0]?.children.length ?? 0} columns · ${block.table.children.length - 1} rows`,
            color: new vscode.ThemeColor('descriptionForeground'),
            textDecoration: 'none; font-size: 12px;',
          } },
        });
      }
      const existing = this.previews.get(key);
      if (existing && existing.version === version) continue;
      existing?.inset.dispose();
      try {
        const content = await this.content(block, editor.document);
        if (generation !== this.generation || version !== editor.document.version || editor !== this.editor) return;
        const height = block.kind === 'image' ? 18 : Math.min(28, 5 + block.table.children.length * 3);
        const inset = vscode.window.createWebviewTextEditorInset(editor, block.startLine, height, {
          enableScripts: true,
          localResourceRoots: this.resourceRoots(editor.document),
        });
        const preview: Preview = { block, inset, height, version };
        this.previews.set(key, preview);
        inset.onDidDispose(() => { if (this.previews.get(key) === preview) this.previews.delete(key); });
        inset.webview.onDidReceiveMessage((message: unknown) => this.onMessage(key, preview, message));
        const editorConfig = vscode.workspace.getConfiguration('editor', editor.document);
        inset.webview.html = renderBlockHtml({
          content,
          label: block.kind === 'image' ? 'Image preview' : 'Table preview',
          nonce: randomBytes(16).toString('hex'), cspSource: inset.webview.cspSource,
          fontFamily: editorConfig.get<string>('fontFamily', 'monospace'),
          fontSize: editorConfig.get<number>('fontSize', 14),
          blockWidth: vscode.workspace.getConfiguration('markdownInlineEditor', editor.document).get<number>('experimental.blockWidth', 560),
        });
      } catch (error) {
        this.enabledUris.delete(editor.document.uri.toString());
        this.autoDisabledUris.add(editor.document.uri.toString());
        await this.restoreSource();
        void vscode.window.showWarningMessage(`Block previews could not start: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    for (const [key, preview] of this.previews) if (!wanted.has(key)) preview.inset.dispose();
    this.decorator.setBlockPreviewTables(editor.document.uri.toString(), renderedTables);
    editor.setDecorations(this.summary, summaries);
    if (toUnfold.length) await vscode.commands.executeCommand('editor.unfold', { selectionLines: toUnfold, levels: 1 });
    if (toFold.length) {
      // The folding provider is queried asynchronously by the native editor.
      this.foldingChanged.fire();
      setTimeout(() => {
        if (generation !== this.generation || version !== editor.document.version || editor !== vscode.window.activeTextEditor) return;
        void vscode.commands.executeCommand('editor.fold', { selectionLines: toFold, levels: 1 }).then(() => {
          if (generation === this.generation) for (const line of toFold) this.foldedLines.add(line);
        });
      }, 250);
    }
  }

  private onMessage(key: string, preview: Preview, message: unknown): void {
    if (!message || typeof message !== 'object' || this.previews.get(key) !== preview || !this.editor) return;
    const value = message as { type?: unknown; pixels?: unknown; imageLoaded?: unknown; columns?: unknown; clientWidth?: unknown; scrollWidth?: unknown; scrollLeft?: unknown };
    if (value.type === 'edit') {
      void this.editSource(preview);
    } else if (value.type === 'size') {
      const config = vscode.workspace.getConfiguration('editor', this.editor.document);
      const size = config.get<number>('fontSize', 14);
      const configured = config.get<number>('lineHeight', 0);
      const lineHeight = configured === 0 ? Math.round(size * 1.5) : configured < 8 ? Math.round(configured * size) : configured;
      const height = measuredInsetLines(value.pixels, lineHeight);
      if (height === undefined) return;
      // Inset height is immutable in this proposed API. Keep the reserved frame
      // stable and scroll content within it; recreating insets leaks webviews in
      // the current native implementation ($disposeEditorInset removes only the zone).
      preview.contentHeight = value.pixels as number;
      preview.ready = preview.block.kind === 'image' ? value.imageLoaded === true : typeof value.columns === 'number' && value.columns > 0;
      if (typeof value.columns === 'number') preview.columns = value.columns;
      if (typeof value.clientWidth === 'number') preview.clientWidth = value.clientWidth;
      if (typeof value.scrollWidth === 'number') preview.scrollWidth = value.scrollWidth;
      if (typeof value.scrollLeft === 'number') preview.scrollLeft = value.scrollLeft;
    }
  }

  private async editSource(preview: Preview): Promise<void> {
    const editor = this.editor;
    if (!editor) return;
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    const position = new vscode.Position(preview.block.startLine, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    this.refresh();
  }

  private resourceRoots(document: vscode.TextDocument): vscode.Uri[] {
    return [vscode.Uri.joinPath(document.uri, '..'), ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [])];
  }

  private async content(block: PreviewBlock, document: vscode.TextDocument): Promise<string> {
    if (block.kind === 'table') return renderTable(block.table);
    const target = resolveImageTarget(block.url, document.uri);
    const roots = this.resourceRoots(document);
    const allowed = target?.scheme === 'file' && roots.some(root => target.path.startsWith(`${root.path.replace(/\/$/, '')}/`));
    if (!target || !allowed) return '<p>Only local workspace images are rendered in this prototype. Edit source to inspect the image link.</p>';
    try {
      const stat = await vscode.workspace.fs.stat(target);
      if (stat.size > 8 * 1024 * 1024) return '<p>Image exceeds the prototype limit of 8 MB. Edit source to open it separately.</p>';
      const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const type = types[target.path.split('.').pop()?.toLowerCase() ?? ''];
      if (!type) return '<p>This image format is not supported in the prototype.</p>';
      const bytes = await vscode.workspace.fs.readFile(target);
      const source = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
      return `<figure><img src="${source}" alt="${escapeHtml(block.alt)}"><figcaption>${escapeHtml(block.alt)}</figcaption></figure>`;
    } catch {
      return '<p class="error">Image could not be loaded. Edit source to check the path.</p>';
    }
  }

  private clearInsets(): void {
    for (const preview of [...this.previews.values()]) preview.inset.dispose();
    this.previews.clear();
  }

  private async restoreSource(): Promise<void> {
    this.clearInsets();
    if (!this.editor) return;
    this.editor.setDecorations(this.summary, []);
    this.decorator.setBlockPreviewTables(this.editor.document.uri.toString(), []);
    if (this.foldedLines.size && vscode.window.activeTextEditor === this.editor) {
      const selectionLines = [...this.foldedLines];
      this.foldedLines.clear();
      await vscode.commands.executeCommand('editor.unfold', { selectionLines, levels: 1 });
    }
    this.foldedLines.clear();
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    clearTimeout(this.timer);
    void this.restoreSource();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.foldingChanged.dispose();
    this.summary.dispose();
  }
}
