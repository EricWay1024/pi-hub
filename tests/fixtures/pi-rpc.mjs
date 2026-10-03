#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
const file = process.argv[process.argv.indexOf('--session') + 1];
const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const header = entries[0], name = entries.findLast(e => e.type === 'session_info')?.name;
if (process.env.PI_HUB_PI_TEST_LOG) appendFileSync(process.env.PI_HUB_PI_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (process.env.PI_HUB_PI_TEST_LOG) appendFileSync(process.env.PI_HUB_PI_TEST_LOG, line + '\n');
  const send = data => process.stdout.write(JSON.stringify({ type: 'response', id: r.id, command: r.type, success: true, data }) + '\n');
  if (r.type === 'get_state') send({ sessionId: header.id, sessionFile: file, sessionName: name, model: { id: 'saved-pi-model' }, thinkingLevel: 'high' });
  else if (r.type === 'get_session_stats') send({ sessionId: header.id, contextUsage: { tokens: null, contextWindow: 200000 } });
  else if (r.type === 'get_commands') send({ commands: [] });
  else send({});
});
