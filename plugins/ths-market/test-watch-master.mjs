import assert from 'node:assert/strict';
import test from 'node:test';
import { isWatchMaster } from './index.js';

test('specific Feishu identity can be the sole watch master', () => {
  const personal = ['node', 'dsh', '--profile', 'personal-investment'];
  const guests = ['node', 'dsh', '--profile', 'guests'];
  assert.equal(isWatchMaster(personal, 'personal-investment').isMaster, true);
  assert.equal(isWatchMaster(guests, 'personal-investment').isMaster, false);
  assert.equal(isWatchMaster(guests, 'feishu').isMaster, true);
});

test('Web does not become a Feishu master', () => {
  const web = ['node', 'dsh', '--profile', 'web', '--port', '3080'];
  assert.equal(isWatchMaster(web, 'feishu').isMaster, false);
  assert.equal(isWatchMaster(web, 'web').isMaster, true);
});
