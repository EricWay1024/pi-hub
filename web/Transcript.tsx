import { useMemo } from 'react';
import type { RecordData } from '../shared/state';
import { contentBlocks, hasText, responseGroups } from '../shared/output';
import { RichText } from './RichText';
import { OutputText, ToolCard } from './ToolOutput';
export function Transcript({ messages, partial, tools = {} }: { messages: RecordData[]; partial?: RecordData; tools?: Record<string, RecordData> }) {
  const groups = useMemo(() => responseGroups(messages, partial), [messages, partial]);
  const calls = new Set<string>(), results = new Map<string, RecordData>();
  for (const message of [...messages, ...(partial ? [partial] : [])]) {
    for (const block of contentBlocks(message)) if (block.type === 'toolCall' && block.id) calls.add(block.id);
    if (message.role === 'toolResult' && message.toolCallId) results.set(message.toolCallId, message);
  }
  function body(message: RecordData) {
    if (message.role === 'toolResult') return calls.has(message.toolCallId) ? null : <ToolCard name={message.toolName || 'tool'} args={tools[message.toolCallId]?.args} result={message}/>;
    if (message.role === 'bashExecution') return <ToolCard name="bash" args={{ command: message.command }} result={{ content: [{ type: 'text', text: message.output || '' }], details: { exitCode: message.exitCode }, isError: !!message.exitCode }}/>;
    return <div className={'message ' + message.role}>
      {contentBlocks(message).map((block, i) => {
        if (block.type === 'text' && hasText(block.text)) return <RichText key={i} text={block.text} preserveLineBreaks={message.role === 'user'}/>;
        if (block.type === 'thinking' && hasText(block.thinking)) {
          const text = block.thinking.trim(), words = text.split(/\s+/).length;
          if (words <= 100) return <div key={i} className="reasoning-brief" role="note" aria-label="Reasoning"><RichText text={text}/></div>;
          return <details key={i} className="thinking"><summary>Reasoning · {words} words</summary><RichText text={text}/></details>;
        }
        if (block.type === 'toolCall') return <ToolCard key={block.id || i} name={block.name} args={block.arguments} result={results.get(block.id)} execution={tools[block.id]}/>;
        if (block.type === 'image' && ['image/png','image/jpeg','image/webp','image/gif'].includes(block.mimeType)) return <img key={i} className="attachment" alt="Attached image" src={`data:${block.mimeType};base64,${block.data}`}/>;
        return null;
      })}
      {hasText(message.summary) && <RichText text={message.summary}/>}
      {hasText(message.errorMessage) && <div className="output-error"><OutputText text={message.errorMessage}/></div>}
    </div>;
  }
  return <>{groups.map(group => {
    const rendered = group.messages.filter(({ message }) => message.role !== 'toolResult' || !calls.has(message.toolCallId));
    if (!rendered.length) return null;
    return <section className={group.actor === 'user' ? 'user-turn' : 'agent-turn'} key={group.key}>
      <div className="eyebrow turn-label">{group.actor === 'user' ? 'You' : 'Pi'}</div>
      {rendered.map(({ key, message }) => <div className="message-row" key={key}>{body(message)}</div>)}
    </section>;
  })}</>;
}
