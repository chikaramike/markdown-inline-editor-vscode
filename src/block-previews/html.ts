import { escapeHtml } from './model';

/** Build a locked-down, theme-aware inset with measured height and an edit action. */
export function renderBlockHtml(options: {
  content: string; label: string; nonce: string; cspSource: string;
  fontFamily: string; fontSize: number; blockWidth?: number;
}): string {
  const { content, label, nonce, cspSource, fontFamily, fontSize } = options;
  const blockWidth = Math.max(240, Math.min(1600, options.blockWidth ?? 560));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${escapeHtml(cspSource)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}
body{font: ${fontSize}px/1.55 ${escapeHtml(fontFamily)};}#block{width:${blockWidth}px;max-width:100%;overflow:hidden;padding:8px 12px 12px;border-left:2px solid var(--vscode-textLink-foreground)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;color:var(--vscode-descriptionForeground);font:12px var(--vscode-font-family)}nav{display:flex;gap:4px;flex-shrink:0}
button{font:inherit;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-contrastBorder,transparent);padding:4px 10px;border-radius:3px}
button:focus-visible,.table-scroll:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
figure{margin:0}img{display:block;max-width:100%;max-height:calc(100vh - 104px);width:auto;height:auto;object-fit:contain;margin:0 auto}
figcaption{font:12px/1.5 var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding-top:8px}.error{color:var(--vscode-errorForeground)}
.table-scroll{overflow:auto;width:100%;max-height:calc(100vh - 64px)}table{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;font:13px/1.55 var(--vscode-font-family)}
.align-left{text-align:left}.align-center{text-align:center}.align-right{text-align:right}
${Array.from({length:100},(_,i)=>`.columns-${i+1}{min-width:${Math.max(480,(i+1)*160)}px}`).join('')}
th,td{padding:10px 12px;vertical-align:top;white-space:normal;overflow-wrap:anywhere;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border)}
th:first-child,td:first-child{width:32%}th{font-weight:600;color:var(--vscode-textLink-foreground);background:var(--vscode-editorWidget-background);position:sticky;top:0;z-index:1}
tbody tr:nth-child(even){background:var(--vscode-textBlockQuote-background)}code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 3px}
</style></head><body><main id="block"><header><span>${escapeHtml(label)}</span><nav>${content.includes('class="table-scroll"') ? '<button id="previous" type="button" title="Previous columns" aria-label="Previous columns">←</button><button id="next" type="button" title="Next columns" aria-label="Next columns">→</button>' : ''}<button id="edit" type="button">Edit source</button></nav></header>${content}</main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const root=document.getElementById('block');let last=0;
function measure(){const h=Math.ceil(root.getBoundingClientRect().height);const img=root.querySelector('img');const table=root.querySelector('table');const scroll=root.querySelector('.table-scroll');const signature=[h,img?.naturalWidth,scroll?.clientWidth,scroll?.scrollWidth,scroll?.scrollLeft].join(':');if(signature!==last){last=signature;vscode.postMessage({type:'size',pixels:h,imageLoaded:!!img?.naturalWidth,columns:table?.querySelectorAll('thead th').length??0,clientWidth:scroll?.clientWidth??0,scrollWidth:scroll?.scrollWidth??0,scrollLeft:scroll?.scrollLeft??0});}}
document.getElementById('edit').addEventListener('click',()=>vscode.postMessage({type:'edit'}));
const scroll=root.querySelector('.table-scroll');
if(scroll){document.getElementById('previous').addEventListener('click',()=>{scroll.scrollLeft-=scroll.clientWidth*.75;measure();});document.getElementById('next').addEventListener('click',()=>{scroll.scrollLeft+=scroll.clientWidth*.75;measure();});scroll.addEventListener('scroll',measure);}
window.addEventListener('message',event=>{if(event.data?.type==='scrollTableEnd'&&scroll){scroll.scrollLeft=scroll.scrollWidth;measure();}});
document.querySelectorAll('img').forEach(img=>{img.addEventListener('load',measure);img.addEventListener('error',()=>{const p=document.createElement('p');p.className='error';p.textContent='Image could not be loaded. Edit source to check the path.';img.replaceWith(p);measure();});});
new ResizeObserver(measure).observe(root);window.addEventListener('load',measure);measure();
</script></body></html>`;
}
