// Values accepted by LGDeviceController.Set_SystemTempMode, NOT FanModeValue enum values.
export const fanModes = [
  { id: 'noiseless', value: 3, label: '无声', description: '限制性能以减少风扇噪音，机身可能变热。' },
  { id: 'silent', value: 0, label: '低噪', description: '降低噪音，可能降低性能。' },
  { id: 'normal', value: 1, label: '正常', description: '根据负载自动平衡散热、噪音和性能。' },
  { id: 'performance', value: 2, label: '高性能', description: '更积极地散热，噪音和耗电可能增加。' },
  { id: 'boost', value: 4, label: '增强散热', description: '进一步增强散热，噪音和耗电可能增加。' },
  { id: 'auto', value: 5, label: '自动', description: '由 LG 自动选择散热模式。' },
  { id: 'max', value: 6, label: '最大散热', description: '使用 LG 最大散热模式，噪音和耗电可能增加。' },
] as const;
export type FanMode = typeof fanModes[number]['id'];
export function modesForType(type: string) {
  const ids: Record<string, readonly FanMode[]> = {
    ThreeLevel: ['silent', 'normal', 'performance'],
    FourLevel: ['noiseless', 'silent', 'normal', 'performance'],
    FourLevelBoost: ['silent', 'normal', 'performance', 'boost'],
    FivelLevelAuto: ['auto', 'noiseless', 'silent', 'normal', 'performance'],
    FourLevelMax: ['silent', 'normal', 'performance', 'max'],
  };
  return (ids[type] || []).map(id => fanModes.find(mode => mode.id === id)!);
}
export type FanStatus = {
  available: boolean;
  model?: string;
  mode?: FanMode;
  modes: readonly typeof fanModes[number][];
  reason?: string;
};
