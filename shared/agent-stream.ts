import type { RecordData } from './state.js';

// A fresh connection starts with complete snapshots. Subsequent frames replace
// only changed fields/tools; omitted fields are unchanged, not empty. Nothing is
// truncated, and reconnect never depends on another connection's baseline.
export class AgentStreamEncoder {
  private agents = new Map<string, { fields: Map<string, string>; tools: Map<string, string> }>();
  encode(record: RecordData): RecordData | undefined {
    if (record.type === 'agents') {
      const ids = new Set(record.agents.map((agent: RecordData) => agent.id));
      for (const id of this.agents.keys()) if (!ids.has(id)) this.agents.delete(id);
      return record;
    }
    if (record.type !== 'agent') return record;
    const agent = record.agent, previous = this.agents.get(agent.id);
    const fields = new Map<string, string>(), tools = new Map<string, string>();
    const set: RecordData = {}, put: RecordData = {};
    for (const [key, value] of Object.entries(agent)) {
      if (key === 'tools') continue;
      const json = JSON.stringify(value); if (json === undefined) continue;
      fields.set(key, json);
      if (previous?.fields.get(key) !== json) set[key] = value;
    }
    for (const [id, tool] of Object.entries(agent.tools || {})) {
      const json = JSON.stringify(tool); tools.set(id, json);
      if (previous?.tools.get(id) !== json) put[id] = tool;
    }
    this.agents.set(agent.id, { fields, tools });
    if (!previous) return record;
    const unset = [...previous.fields.keys()].filter(key => !fields.has(key));
    const remove = [...previous.tools.keys()].filter(id => !tools.has(id));
    if (!Object.keys(set).length && !unset.length && !Object.keys(put).length && !remove.length) return;
    return { type: 'agent_patch', agentId: agent.id, set, unset, tools: { put, remove } };
  }
}

export class AgentStreamDecoder {
  private agents = new Map<string, RecordData>();
  decode(record: RecordData): RecordData {
    if (record.type === 'agents') {
      const ids = new Set(record.agents.map((agent: RecordData) => agent.id));
      for (const id of this.agents.keys()) if (!ids.has(id)) this.agents.delete(id);
    }
    if (record.type === 'agent') this.agents.set(record.agent.id, record.agent);
    if (record.type !== 'agent_patch') return record;
    const previous = this.agents.get(record.agentId);
    if (!previous) throw new Error('Agent update arrived before its snapshot; reconnect required');
    const agent = { ...previous, ...record.set };
    for (const key of record.unset) delete agent[key];
    if (Object.keys(record.tools.put).length || record.tools.remove.length) {
      agent.tools = { ...previous.tools, ...record.tools.put };
      for (const id of record.tools.remove) delete agent.tools[id];
    }
    this.agents.set(record.agentId, agent);
    return { type: 'agent', agent };
  }
}
