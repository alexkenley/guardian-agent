import { WindowsPerformanceAdapter } from './windows.js';
import { FallbackPerformanceAdapter } from './fallback.js';
import { PerformanceAdapter } from './types.js';

export function createPerformanceAdapter(): PerformanceAdapter {
  if (process.platform === 'win32') {
    return new WindowsPerformanceAdapter();
  }
  return new FallbackPerformanceAdapter();
}
