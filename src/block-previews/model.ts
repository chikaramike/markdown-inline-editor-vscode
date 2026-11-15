import type { Root, Table, PhrasingContent } from 'mdast';
import type { ParseEntry } from '../markdown-parse-cache';
import { normalizeToLF } from '../position-mapping';
import { getRemarkProcessorSync } from '../parser-remark';

type BlockPosition = { startLine: number; endLine: number; startPos: number; endPos: number };
export type ImageBlock = BlockPosition & { kind: 'image'; url: string; alt: string };
export type TableBlock = BlockPosition & { kind: 'table'; table: Table };
export type PreviewBlock = ImageBlock | TableBlock;

/** Derive blocks once per existing parse-cache entry, never on cursor movement. */
export function extractPreviewBlocks(entry: ParseEntry): PreviewBlock[] {
  const text = normalizeToLF(entry.text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low;
  };
  const blocks: PreviewBlock[] = [];
  for (const scope of entry.scopes) {
    if (scope.kind !== 'image' && scope.kind !== 'table') continue;
    const position = {
      startPos: scope.startPos, endPos: scope.endPos,
      startLine: lineAt(scope.startPos), endLine: lineAt(Math.max(scope.startPos, scope.endPos - 1)),
    };
    // Allow whitespace-only indentation (list-item continuation). Insets are line-anchored and
    // full-width, so indentation does not shift them. Marker-line (`- ![x]`) and blockquote
    // (`> ![x]`) prefixes stay excluded; indented code produces no image/table scope.
    const prefix = text.slice(lineStarts[position.startLine], scope.startPos);
    const lastLineEnd = text.indexOf('\n', scope.endPos);
    const suffix = text.slice(scope.endPos, lastLineEnd === -1 ? text.length : lastLineEnd);
    if (!/^[ \t]*$/.test(prefix) || suffix.trim()) continue;
    // Remove the shared continuation indent from later lines so an indented table re-parses as a table.
    const source = prefix
      ? text.slice(scope.startPos, scope.endPos).split('\n').map((l, i) => (i > 0 && l.startsWith(prefix) ? l.slice(prefix.length) : l)).join('\n')
      : text.slice(scope.startPos, scope.endPos);
    const { unified, remarkParse, remarkGfm } = getRemarkProcessorSync();
    const root = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
    const node = root.children[0];
    if (scope.kind === 'table' && node?.type === 'table') {
      blocks.push({ ...position, kind: 'table', table: node });
    } else if (scope.kind === 'image' && node?.type === 'paragraph' && node.children.length === 1) {
      const image = node.children[0];
      if (image.type === 'image' && position.startLine === position.endLine) {
        blocks.push({ ...position, kind: 'image', url: image.url, alt: image.alt ?? '' });
      }
    }
  }
  return blocks;
}

/** Escape all source-derived content before embedding it in a webview. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function renderInline(node: PhrasingContent): string {
  switch (node.type) {
    case 'text': case 'html': return escapeHtml(node.value);
    case 'inlineCode': return `<code>${escapeHtml(node.value)}</code>`;
    case 'strong': return `<strong>${node.children.map(renderInline).join('')}</strong>`;
    case 'emphasis': return `<em>${node.children.map(renderInline).join('')}</em>`;
    case 'delete': return `<del>${node.children.map(renderInline).join('')}</del>`;
    case 'link': case 'linkReference': return node.children.map(renderInline).join('');
    case 'image': case 'imageReference': return escapeHtml(node.alt ?? '');
    case 'break': return '<br>';
    default: return '';
  }
}

/** Real HTML cells wrap independently; wide tables scroll inside their own block. */
export function renderTable(table: Table): string {
  const columns = table.children[0]?.children.length ?? 0;
  const rows = table.children.slice(0, 201);
  const renderRow = (row: Table['children'][number], header: boolean): string => {
    const tag = header ? 'th' : 'td';
    return `<tr>${Array.from({ length: columns }, (_, i) => {
      const align = table.align?.[i] ?? 'left';
      return `<${tag}${header ? ' scope="col"' : ''} class="align-${align}">${row.children[i]?.children.map(renderInline).join('') ?? ''}</${tag}>`;
    }).join('')}</tr>`;
  };
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Table preview"><table class="columns-${Math.min(100, columns)}"><thead>${rows[0] ? renderRow(rows[0], true) : ''}</thead><tbody>${rows.slice(1).map(r => renderRow(r, false)).join('')}</tbody></table></div>${table.children.length > 201 ? '<p>Preview limited to 200 data rows. Edit source to see all rows.</p>' : ''}`;
}

/** Clamp untrusted webview measurements to a bounded number of editor lines. */
export function measuredInsetLines(pixels: unknown, lineHeight: number): number | undefined {
  if (typeof pixels !== 'number' || !Number.isFinite(pixels) || pixels <= 0) return undefined;
  return Math.max(3, Math.min(48, Math.ceil(pixels / Math.max(8, lineHeight)) + 1));
}
