import type { Exporter } from '@deepseek-ai/cordis';

/** Export structured DSH logs to the long-running channel's stdout/stderr. */
export function consoleExporter(): Exporter {
  return {
    levels: { default: 3 },
    export(message) {
      if (message.type === 'debug' && process.env.FEISHU_DEBUG !== '1') return;
      const prefix = `[${new Date(message.ts).toISOString()}] ${message.name} [${message.type}]`;
      const write =
        message.type === 'error' || message.type === 'warn' ? console.error : console.log;
      write(prefix, ...message.args);
    },
  };
}
