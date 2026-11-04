import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fanModes, modesForType, type FanMode, type FanStatus } from '../shared/fan.js';

const exec = promisify(execFile);
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export type FanReading = { model: string; type: string; value: number };
export interface FanControl {
  status(): Promise<FanStatus>;
  set(mode: FanMode): Promise<FanStatus>;
}
export class FanError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}
export async function readLgFan(value = -1): Promise<FanReading> {
  const script = await readFile(new URL('./lg-fan.ps1', import.meta.url), 'utf8');
  // No shell or browser-supplied commands/paths. Bound the process and its output.
  if (!Number.isInteger(value) || value < -1 || value > 6) throw new FanError('Invalid cooling mode', 400);
  const command = Buffer.from(`$RequestedMode = ${value}\n${script}`, 'utf16le').toString('base64');
  try {
    const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      timeout: 8000, maxBuffer: 32 * 1024, windowsHide: true,
    });
    const result: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!result || typeof result !== 'object') throw new Error();
    const r = result as FanReading;
    if (typeof r.model !== 'string' || r.model.length > 100 || typeof r.type !== 'string' || !Number.isInteger(r.value)) throw new Error();
    return r;
  } catch {
    throw new FanError('无法读取 LG 散热接口或确认切换结果。请检查本机 LG Smart Assistant；刷新状态后再尝试。');
  }
}
function fanStatus(reading: FanReading): FanStatus {
  const modes = modesForType(reading.type), current = modes.find(mode => mode.value === reading.value);
  if (!current) throw new FanError('此 LG 机型的散热接口或当前模式暂不受支持。');
  return { available: true, model: reading.model, mode: current.id, modes };
}
export function createFanControl(run: (value?: number) => Promise<FanReading> = readLgFan): FanControl {
  let busy = false;
  let cached: FanStatus | undefined, cachedAt = 0;
  let reading: Promise<FanStatus> | undefined;
  async function read() {
    if (cached && Date.now() - cachedAt < 5000) return cached;
    if (reading) return reading;
    reading = run().then(fanStatus).catch((error): FanStatus => ({
      available: false, modes: [], reason: error instanceof FanError ? error.message : 'LG 散热接口不可用。',
    })).then(status => { cached = status; cachedAt = Date.now(); return status; });
    try { return await reading; } finally { reading = undefined; }
  }
  return {
    async status() {
      if (busy) throw new FanError('正在切换散热模式，请稍后刷新。', 409);
      return read();
    },
    async set(mode) {
      const selected = fanModes.find(candidate => candidate.id === mode);
      if (!selected) throw new FanError('Invalid cooling mode', 400);
      if (busy) throw new FanError('正在切换散热模式，请勿重复提交。', 409);
      busy = true;
      try {
        // Wait for any in-flight read before writing; never cache a pre-write result afterwards.
        if (reading) await reading.catch(() => {});
        const before = fanStatus(await run());
        if (!before.modes.some(candidate => candidate.id === mode)) throw new FanError('此电脑不支持该散热模式。', 400);
        const after = before.mode === mode ? before : fanStatus(await run(selected.value));
        if (after.mode !== mode) throw new FanError('无法确认散热模式切换结果，请先刷新状态。');
        cached = after; cachedAt = Date.now(); return after;
      } finally { busy = false; cached = undefined; }
    },
  };
}
