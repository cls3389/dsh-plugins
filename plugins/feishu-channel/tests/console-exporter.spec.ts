import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleExporter } from '../src/console-exporter.js';

describe('console exporter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exports lifecycle logs and gates debug tracing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exporter = consoleExporter();
    exporter.export({ sn: 1, level: 2, ts: 0, name: 'feishu', type: 'info', args: ['started'] });
    exporter.export({ sn: 2, level: 3, ts: 0, name: 'feishu', type: 'debug', args: ['delta'] });
    expect(log).toHaveBeenCalledWith('[1970-01-01T00:00:00.000Z] feishu [info]', 'started');
    expect(log).toHaveBeenCalledTimes(1);
  });
});
