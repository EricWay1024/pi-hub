import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeMath } from '../shared/math';
function displayMath() {
  return (tree: any, file: any) => {
    const source = String(file);
    function walk(node: any) {
      if (node.type === 'inlineMath' && source.slice(node.position?.start.offset, node.position?.end.offset).startsWith('$$')) node.data.hProperties.className = ['language-math', 'math-display'];
      for (const child of node.children || []) walk(child);
    }
    walk(tree);
  };
}
// Markdown soft breaks normally collapse to spaces. Preserve them only for
// user input, without modifying code/math nodes or assistant Markdown.
function promptLineBreaks() {
  return (tree: any) => {
    function walk(node: any) {
      if (!node.children) return;
      node.children = node.children.flatMap((child: any) => {
        if (child.type === 'text' && /[\r\n]/.test(child.value)) {
          return child.value.split(/\r\n|\r|\n/).flatMap((line: string, i: number) => [
            ...(i ? [{ type: 'break' }] : []), ...(line ? [{ type: 'text', value: line }] : []),
          ]);
        }
        walk(child); return [child];
      });
    }
    walk(tree);
  };
}
export const RichText = React.memo(function RichText({ text, preserveLineBreaks = false }: { text: string; preserveLineBreaks?: boolean }) {
  return <Markdown remarkPlugins={[remarkGfm, remarkMath, displayMath, ...(preserveLineBreaks ? [promptLineBreaks] : [])]} rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]} components={{ a: props => <a {...props} target="_blank" rel="noopener noreferrer"/> }}>{normalizeMath(text)}</Markdown>;
});
