// Experimental VS Code proposal: microsoft/vscode#85682 (MIT).
// Kept separate from stable API types; used only by the opt-in development build.
declare module 'vscode' {
  export interface WebviewEditorInset {
    readonly editor: TextEditor;
    readonly line: number;
    readonly height: number;
    readonly webview: Webview;
    readonly onDidDispose: Event<void>;
    dispose(): void;
  }
  export namespace window {
    export function createWebviewTextEditorInset(editor: TextEditor, line: number, height: number, options?: WebviewOptions): WebviewEditorInset;
  }
}
