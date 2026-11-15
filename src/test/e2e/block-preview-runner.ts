import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

type PreviewApi = {
  toggle(): Promise<boolean>;
  scrollTablesToEnd(): Promise<void>;
  state: { enabled: boolean; previews: { kind: string; line: number; height: number; ready: boolean; columns?: number; clientWidth?: number; scrollWidth?: number; scrollLeft?: number }[] };
};

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Run against the installed editor in an isolated profile with editorInsets enabled. */
export async function run(): Promise<void> {
  const results: string[] = [];
  let previews: PreviewApi | undefined;
  try {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, 'fixture workspace is open');
    const uri = vscode.Uri.joinPath(root, 'preview-demo.md');
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const extension = vscode.extensions.getExtension('CodeSmith.markdown-inline-editor-vscode');
    assert.ok(extension);
    const api = await extension.activate() as { blockPreviews: PreviewApi };
    previews = api.blockPreviews;
    assert.equal(await api.blockPreviews.toggle(), true);
    await until(() => api.blockPreviews.state.previews.length === 2, 'image and table insets created');
    results.push('real image and table insets created');
    await until(() => api.blockPreviews.state.previews.some(p => p.kind === 'image' && p.ready), 'image pixels actually loaded');
    const tableLine = api.blockPreviews.state.previews.find(p => p.kind === 'table')!.line;
    editor.revealRange(new vscode.Range(tableLine, 0, tableLine, 0), vscode.TextEditorRevealType.AtTop);
    await until(() => api.blockPreviews.state.previews.length === 2 && api.blockPreviews.state.previews.every(p => p.ready), 'visible table DOM actually rendered');
    results.push('image pixels loaded and table DOM rendered');
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.ok(api.blockPreviews.state.previews.every(p => p.height >= 3 && p.height <= 48));
    results.push('inset heights bounded');
    const table = api.blockPreviews.state.previews.find(p => p.kind === 'table');
    assert.ok(table);
    assert.equal(table.columns, 5);
    assert.ok((table.scrollWidth ?? 0) >= 800);
    results.push('all five table columns present at readable minimum width');
    assert.ok((table.clientWidth ?? 0) <= 560, 'table frame respects configured width');
    // Native source folding can move the inset out of view after its first render.
    editor.revealRange(new vscode.Range(tableLine, 0, tableLine, 0), vscode.TextEditorRevealType.AtTop);
    await new Promise(resolve => setTimeout(resolve, 600));
    await api.blockPreviews.scrollTablesToEnd();
    await until(() => api.blockPreviews.state.previews.some(p => p.kind === 'table' && (p.scrollLeft ?? 0) > 0), 'rightmost columns reachable by horizontal scrolling');
    results.push('rightmost columns reachable within the bounded table frame');
    const folding = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', uri);
    assert.ok(folding?.some(r => r.start === table.line));
    results.push('table source has native folding range');
    const nativeHeadings = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
    assert.ok(nativeHeadings?.length, 'native Markdown heading navigation retained');
    results.push('native heading navigation retained');
    editor.selection = new vscode.Selection(table.line + 2, 0, table.line + 2, 0);
    await until(() => !api.blockPreviews.state.previews.some(p => p.kind === 'table'), 'editing table reveals source');
    results.push('table inset removed while editing source');
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await until(() => api.blockPreviews.state.previews.length === 2, 'table preview restored');
    results.push('table preview restored after leaving source');
    await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '\n'));
    await until(() => api.blockPreviews.state.previews.some(p => p.kind === 'table' && p.line === tableLine + 1), 'blocks relocate after a document edit');
    await vscode.commands.executeCommand('undo');
    await until(() => api.blockPreviews.state.previews.some(p => p.kind === 'table' && p.line === tableLine), 'blocks relocate after undo');
    results.push('insert and undo relocate block anchors correctly');
    await vscode.workspace.getConfiguration('editor', uri).update('fontSize', 18, vscode.ConfigurationTarget.Workspace);
    await until(() => api.blockPreviews.state.previews.length === 2, 'font resize reconciliation');
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.push('font-size change preserves previews');
    assert.equal(document.getText(), original);
    assert.equal(document.isDirty, false);
    results.push('Markdown document unchanged and clean');
    assert.equal(await api.blockPreviews.toggle(), false);
    assert.equal(api.blockPreviews.state.previews.length, 0);
    assert.equal(document.getText(), original);
    results.push('toggle removes all insets without changing source');
    const autoConfig = vscode.workspace.getConfiguration('markdownInlineEditor', uri);
    try {
      await autoConfig.update('experimental.autoEnable', true, vscode.ConfigurationTarget.Workspace);
      await until(() => api.blockPreviews.state.previews.length === 2, 'saved auto-enable setting creates previews');
      assert.equal(await api.blockPreviews.toggle(), false);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(api.blockPreviews.state.previews.length, 0, 'manual disable overrides auto-enable');
      assert.equal(document.getText(), original);
      results.push('automatic enable works and respects the per-file off toggle');
    } finally {
      await autoConfig.update('experimental.autoEnable', undefined, vscode.ConfigurationTarget.Workspace);
    }
    fs.writeFileSync('/private/tmp/markdown-inline-block-e2e-result.json', JSON.stringify({ passed: true, results }, null, 2));
  } catch (error) {
    fs.writeFileSync('/private/tmp/markdown-inline-block-e2e-result.json', JSON.stringify({ passed: false, results, state: previews?.state, error: String(error) }, null, 2));
    throw error;
  }
}
