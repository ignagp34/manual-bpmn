export type Attrs = Record<string, string | number | boolean | undefined>;

export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderAttrs(attrs: Attrs | undefined): string {
  if (!attrs) return "";
  const parts: string[] = [];
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === undefined) continue;
    parts.push(`${k}="${escape(String(v))}"`);
  }
  return parts.length === 0 ? "" : " " + parts.join(" ");
}

export function selfEl(tag: string, attrs?: Attrs): string {
  return `<${tag}${renderAttrs(attrs)} />`;
}

export function el(tag: string, attrs?: Attrs, body?: string | string[]): string {
  const inner = Array.isArray(body) ? body.filter(Boolean).join("") : body ?? "";
  if (inner === "") return selfEl(tag, attrs);
  return `<${tag}${renderAttrs(attrs)}>${inner}</${tag}>`;
}

export function text(s: string): string {
  return escape(s);
}
