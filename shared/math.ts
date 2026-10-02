/** Accept common LaTeX delimiters without rewriting fenced or inline code. */
export function normalizeMath(source: string): string {
  const chunks: { code: boolean; text: string }[] = [];
  let fence: string | undefined;
  for (const line of source.split(/(?<=\n)/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const code = !!fence || !!marker;
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
    if (chunks.at(-1)?.code === code) chunks.at(-1)!.text += line;
    else chunks.push({ code, text: line });
  }
  return chunks.map(chunk => {
    if (chunk.code) return chunk.text;
    return chunk.text.split(/(`+[^`]*`+)/g).map(part => {
      if (part.startsWith('`')) return part;
      return part.replace(/\\\[([\s\S]*?)\\\]/g, (_m, math) => `\n\n$$\n${math.trim()}\n$$\n\n`)
        .replace(/\\\(([^\n]*?)\\\)/g, (_m, math) => `$${math}$`);
    }).join('');
  }).join('');
}
