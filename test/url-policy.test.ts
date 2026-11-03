import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFetchableUrl } from '../src/poppy/url-policy.ts';

const strict = { allowInsecureLoopback: false };
const dev = { allowInsecureLoopback: true };

test('https public URLs are allowed', () => {
  assert.ok(assertFetchableUrl('https://agent.example/agent.json', strict));
});

test('http, loopback, private and link-local targets are refused in strict mode', () => {
  for (const u of ['http://agent.example/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://10.0.0.5/a', 'https://192.168.1.2/a', 'https://169.254.169.254/latest', 'https://[::1]/a', 'https://user:pw@agent.example/']) {
    assert.throws(() => assertFetchableUrl(u, strict), Error, u);
  }
});

test('dev mode allows loopback only', () => {
  assert.ok(assertFetchableUrl('http://127.0.0.1:7300/agent.json', dev));
  assert.ok(assertFetchableUrl('http://localhost:7300/agent.json', dev));
  assert.throws(() => assertFetchableUrl('http://agent.example/agent.json', dev));
  assert.throws(() => assertFetchableUrl('https://10.1.2.3/agent.json', dev));
});
