import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from './main.js';

function context() {
  return {
    tools: { register() {} },
    logger: { warn() {} },
  };
}

test('public config exposes every gateway setting and denies private baseUrl by default', () => {
  assert.throws(() => apply(context(), {
    baseUrl: 'http://127.0.0.1:18090',
    apiTokenRef: 'BROWSER_GATEWAY_TOKEN',
    allowPrivateNetworks: false,
  }), /allowPrivateNetworks: true/);
});

test('explicit private-network opt-in permits a loopback gateway without registration warnings', () => {
  assert.doesNotThrow(() => apply(context(), {
    baseUrl: 'http://127.0.0.1:18090',
    apiTokenRef: 'BROWSER_GATEWAY_TOKEN',
    allowPrivateNetworks: true,
  }));
});

test('no token produces a visible configuration warning', () => {
  const warnings = [];
  const ctx = context();
  ctx.logger.warn = (message) => warnings.push(message);
  apply(ctx, { baseUrl: 'https://browser.example.com', apiToken: '', apiTokenRef: '' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /apiToken/);
});
