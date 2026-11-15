/** File text ⇄ editor text: line endings and BOM are remembered and restored. No app dependencies (used by the CLI too). */

/** Split a file's content into "\n"-text plus its line ending and BOM. */
export function decodeText(raw: string): { text: string; eol: "\n" | "\r\n"; bom: boolean } {
  const bom = raw.startsWith("\uFEFF");
  const body = bom ? raw.slice(1) : raw;
  return { text: body.replace(/\r\n?/g, "\n"), eol: body.includes("\r\n") ? "\r\n" : "\n", bom };
}

/** File content to write for a buffer. */
export const encodeText = (b: { text: string; eol: "\n" | "\r\n"; bom: boolean }) =>
  (b.bom ? "\uFEFF" : "") + (b.eol === "\n" ? b.text : b.text.replace(/\n/g, b.eol));

