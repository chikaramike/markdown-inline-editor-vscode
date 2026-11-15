import { describe, expect, it } from 'vitest';
import { MarkdownParser } from '../../parser';
import { extractPreviewBlocks, measuredInsetLines, renderTable } from '../model';
import { renderBlockHtml } from '../html';

function blocks(text: string) {
  const parser = new MarkdownParser();
  return extractPreviewBlocks({ version: 1, text, ...parser.extractDecorationsWithScopes(text) });
}

describe('block preview content', () => {
  it('uses parser scopes to exclude fenced code, embedded images, lists, and blockquotes', () => {
    const text = '# Heading\n\n![Plot](./plot.png)\n\nParagraph ![inline](x.png) text\n\n- ![list](x.png)\n\n> ![quote](x.png)\n\n```md\n![code](x.png)\n```\n';
    const result = blocks(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'image', startLine: 2, endLine: 2, url: './plot.png', alt: 'Plot' });
  });

  it('includes standalone images and tables in list-item continuation lines', () => {
    const text = '1. Question\n\n    **Answer:** text\n\n    ![Diagram](./assets/d.svg)\n\n    | A | B |\n    |---|---|\n    | C | D |\n\n10. Next\n\n    ![Two](./two.png)\n';
    const result = blocks(text);
    expect(result.map(b => [b.kind, b.startLine])).toEqual([['image', 4], ['table', 6], ['image', 12]]);
    expect(result[0]).toMatchObject({ url: './assets/d.svg', alt: 'Diagram' });
  });

  it('still excludes images inside indented code blocks', () => {
    expect(blocks('Paragraph\n\n    ![code](x.png)\n')).toHaveLength(0);
  });

  it('maps identical line positions for LF and CRLF without changing document bytes', () => {
    const text = '# Heading\n\n![Plot](./plot.png)\n\n| A | B |\n|---|---|\n| C | D |\n';
    expect(blocks(text.replace(/\n/g, '\r\n'))).toEqual(blocks(text));
  });

  it('renders a wide table with semantic cells and independent alignment', () => {
    const block = blocks('| Characteristic | Perfect competition | Monopoly |\n|:---|:---:|---:|\n| Very long description that needs wrapping | **Yes** and `code` | No |')[0];
    expect(block.kind).toBe('table');
    if (block.kind !== 'table') throw new Error('expected table');
    const html = renderTable(block.table);
    expect(html).toContain('<thead>');
    expect(html).toContain('scope="col" class="align-center"');
    expect(html).toContain('<td class="align-right">No</td>');
    expect(html).toContain('<strong>Yes</strong> and <code>code</code>');
    expect(html).toContain('Very long description that needs wrapping');
    expect(html).toContain('class="table-scroll"');
    expect(html).not.toContain(' style=');
  });

  it('escapes raw HTML and never follows links or renders images inside table cells', () => {
    const block = blocks('| A |\n|---|\n| <img src=x onerror=alert(1)> [visit](https://example.com) ![alt](https://example.com/a.png) |')[0];
    if (block.kind !== 'table') throw new Error('expected table');
    const html = renderTable(block.table);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('https://example.com');
    expect(html).toContain('visit');
  });

  it('handles escaped pipes and inline-code pipes through the Markdown AST', () => {
    const block = blocks('| A | B |\n|---|---|\n| x\\|y | `p\\|q` |')[0];
    if (block.kind !== 'table') throw new Error('expected table');
    expect(renderTable(block.table)).toContain('x|y');
    expect(renderTable(block.table)).toContain('<code>p|q</code>');
  });

  it('rejects malformed height messages and bounds native block height', () => {
    for (const value of [null, '100', -1, 0, NaN, Infinity, {}]) expect(measuredInsetLines(value, 20)).toBeUndefined();
    expect(measuredInsetLines(121, 20)).toBe(8);
    expect(measuredInsetLines(100000, 20)).toBe(48);
  });

  it('uses restrictive CSP and safe text labels, with wrapping inside the table', () => {
    const html = renderBlockHtml({ content: '<p>Safe</p>', label: '<script>alert(1)</script>', nonce: 'testnonce', cspSource: 'vscode-webview:', fontFamily: 'monospace', fontSize: 14 });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src data: vscode-webview:");
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
