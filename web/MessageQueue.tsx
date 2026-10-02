import type { AgentState } from '../shared/state';
import { RichText } from './RichText';
export function MessageQueue({ queue }: { queue?: AgentState['queue'] }) {
  if (!queue || (!queue.steering.length && !queue.followUp.length)) return null;
  return <section className="message-queue" aria-label="Pending messages" aria-live="polite"><div className="eyebrow">Your message queue</div>
    {(['steering','followUp'] as const).flatMap(mode => queue[mode].map((text, i) => <article className="queued-message" key={`${mode}-${i}`}>
      <div className="queued-message-label"><strong>{mode === 'steering' ? 'Steering' : 'Follow-up'}</strong><span>{queue.tracked === false ? 'Submitted' : 'Queued'}</span></div>
      <RichText text={text}/><small>{mode === 'steering' ? 'Delivered at the next turn boundary.' : 'Waiting until current work finishes.'}</small>
    </article>))}
  </section>;
}
