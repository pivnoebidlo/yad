/**
 * Filter text for the side lists: words separated by spaces, every word must
 * occur (case-insensitive) somewhere in the item's text. Returns null for an
 * empty query (no filtering).
 */
export function matcher(query: string): ((text: string) => boolean) | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return (text) => {
    const t = text.toLowerCase();
    return words.every((w) => t.includes(w));
  };
}
