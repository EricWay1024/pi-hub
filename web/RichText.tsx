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
export const RichText = React.memo(function RichText({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm, remarkMath, displayMath]} rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]} components={{ a: props => <a {...props} target="_blank" rel="noopener noreferrer"/> }}>{normalizeMath(text)}</Markdown>;
});
