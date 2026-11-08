import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate, OutcomeUnknownError, formatApprovalHeader, parseApprovalHeader, type GateRequest } from '../src/poppy/operations.ts';

test('Poppy-Approval header parses RFC 9651 dictionary strings', () => {
  assert.deepEqual(parseApprovalHeader('operation_id="exc_5Rt2", revision="1791487200-k3Jd9Qx2mW8v"'), { operation_id: 'exc_5Rt2', revision: '1791487200-k3Jd9Qx2mW8v' });
  assert.deepEqual(parseApprovalHeader('revision="r1";x=1,operation_id="o1", future=?1'), { operation_id: 'o1', revision: 'r1' });
  assert.deepEqual(parseApprovalHeader('operation_id="a\\"b", revision="c\\\\d"'), { operation_id: 'a"b', revision: 'c\\d' });
  for (const bad of [undefined, '', 'operation_id="x"', 'operation_id=x, revision=y', 'operation_id="x, revision="y"', 'Operation_ID="x", revision="y"']) {
    assert.equal(parseApprovalHeader(bad), null, String(bad));
  }
  const a = { operation_id: 'o"1', revision: 'r\\1' };
  assert.deepEqual(parseApprovalHeader(formatApprovalHeader(a)), a);
});

function harness(opts: { performDelayMs?: number; performTimeoutMs?: number; failTimes?: number } = {}) {
  let now = Date.now();
  const gate = new ApprovalGate<{ n: number }>({ now: () => now, performTimeoutMs: opts.performTimeoutMs ?? 2000 });
  let performed = 0;
  let quotes = 0;
  let fails = opts.failTimes ?? 0;
  const req = (over: Partial<GateRequest<{ n: number }>> = {}): GateRequest<{ n: number }> => ({
    ownerKey: 'session-A',
    actionKey: 'order:seller',
    fingerprint: 'cart-1',
    approval: null,
    quote: async () => ({ summary: `Buy ${++quotes}`, terms: { total: '100.00' }, ttlSec: 600, context: { n: quotes } }),
    perform: async (ctx) => {
      if (opts.performDelayMs) await new Promise((r) => setTimeout(r, opts.performDelayMs));
      if (fails > 0) {
        fails--;
        throw new Error('seller said no');
      }
      performed++;
      return { status: 201, body: { order: `ORD-${ctx.n}` } };
    },
    ...over,
  });
  return { gate, req, get performed() { return performed; }, advance: (ms: number) => { now += ms; } };
}

test('first request asks for approval and performs nothing', async () => {
  const h = harness();
  const r = await h.gate.handle(h.req());
  assert.equal(r.kind, 'approval_required');
  assert.equal(h.performed, 0);
  if (r.kind === 'approval_required') {
    assert.match(r.operation.operation_id, /^[A-Za-z0-9_-]+$/);
    assert.match(r.operation.revision, /^[A-Za-z0-9_-]+$/);
    assert.ok(Date.parse(r.operation.expires_at) > Date.now());
  }
});

test('approval performs exactly once; retries replay the first response', async () => {
  const h = harness();
  const r1 = await h.gate.handle(h.req());
  assert.equal(r1.kind, 'approval_required');
  const op = (r1 as { operation: { operation_id: string; revision: string } }).operation;
  const approval = { operation_id: op.operation_id, revision: op.revision };
  const r2 = await h.gate.handle(h.req({ approval }));
  const r3 = await h.gate.handle(h.req({ approval }));
  assert.equal(r2.kind, 'performed');
  assert.equal(r3.kind, 'performed');
  assert.deepEqual((r2 as { response: unknown }).response, (r3 as { response: unknown }).response);
  assert.equal((r3 as { replayed: boolean }).replayed, true);
  assert.equal(h.performed, 1);
});

test('new terms keep the operation_id but get a new revision', async () => {
  const h = harness();
  const a = (await h.gate.handle(h.req())) as { operation: { operation_id: string; revision: string } };
  const b = (await h.gate.handle(h.req({ fingerprint: 'cart-2' }))) as { operation: { operation_id: string; revision: string } };
  assert.equal(a.operation.operation_id, b.operation.operation_id);
  assert.notEqual(a.operation.revision, b.operation.revision);
});

test('an approval for different terms performs nothing and returns a different revision', async () => {
  const h = harness();
  const a = (await h.gate.handle(h.req())) as { operation: { operation_id: string; revision: string } };
  const approval = { operation_id: a.operation.operation_id, revision: a.operation.revision };
  const r = await h.gate.handle(h.req({ approval, fingerprint: 'cart-CHANGED' }));
  assert.equal(r.kind, 'approval_required');
  assert.notEqual((r as { operation: { revision: string } }).operation.revision, approval.revision);
  assert.equal(h.performed, 0);
});

test('an expired revision is not performed', async () => {
  const h = harness();
  const a = (await h.gate.handle(h.req())) as { operation: { operation_id: string; revision: string } };
  h.advance(601_000);
  const r = await h.gate.handle(h.req({ approval: { operation_id: a.operation.operation_id, revision: a.operation.revision } }));
  assert.equal(r.kind, 'approval_required');
  assert.equal(h.performed, 0);
});

test('another Session cannot use the approval (signed-out operations belong to their Session)', async () => {
  const h = harness();
  const a = (await h.gate.handle(h.req())) as { operation: { operation_id: string; revision: string } };
  const r = await h.gate.handle(h.req({ ownerKey: 'session-B', approval: { operation_id: a.operation.operation_id, revision: a.operation.revision } }));
  assert.equal(r.kind, 'approval_required');
  assert.notEqual((r as { operation: { operation_id: string } }).operation.operation_id, a.operation.operation_id);
  assert.equal(h.performed, 0);
});

test('concurrent approvals perform once; the loser gets in_progress', async () => {
  const h = harness({ performDelayMs: 100 });
  const a = (await h.gate.handle(h.req())) as { operation: { operation_id: string; revision: string } };
  const approval = { operation_id: a.operation.operation_id, revision: a.operation.revision };
  const [x, y] = await Promise.all([h.gate.handle(h.req({ approval })), h.gate.handle(h.req({ approval }))]);
  const kinds = [x.kind, y.kind].sort();
  assert.deepEqual(kinds, ['in_progress', 'performed']);
  assert.equal(h.performed, 1);
});

test('unknown outcome answers in_progress, then the late result is replayed', async () => {
  const h = harness({ performDelayMs: 150, performTimeoutMs: 20 });
  const a = (await h.gate.handle(h.req())) as { operation: { operation_id: string; revision: string } };
  const approval = { operation_id: a.operation.operation_id, revision: a.operation.revision };
  assert.equal((await h.gate.handle(h.req({ approval }))).kind, 'in_progress');
  await new Promise((r) => setTimeout(r, 250));
  const later = await h.gate.handle(h.req({ approval }));
  assert.equal(later.kind, 'performed');
  assert.equal(h.performed, 1);
});

test('a definite failure leaves the operation approvable again, still at most one success', async () => {
  const h = harness({ failTimes: 1 });
  const a = (await h.gate.handle(h.req())) as { operation: { operation_id: string; revision: string } };
  const approval = { operation_id: a.operation.operation_id, revision: a.operation.revision };
  await assert.rejects(h.gate.handle(h.req({ approval })), /seller said no/);
  const r = await h.gate.handle(h.req({ approval }));
  assert.equal(r.kind, 'performed');
  assert.equal(h.performed, 1);
});

function unknownHarness() {
  const gate = new ApprovalGate<{ n: number }>({ performTimeoutMs: 2000 });
  let sent = 0;
  let mode: 'unknown' | 'definite' | 'ok' = 'unknown';
  const req = (over: Partial<GateRequest<{ n: number }>> = {}): GateRequest<{ n: number }> => ({
    ownerKey: 'session-A',
    actionKey: 'order:seller',
    fingerprint: 'cart-1',
    approval: null,
    quote: async () => ({ summary: 'Buy', terms: { total: '100.00' }, ttlSec: 600, context: { n: 1 } }),
    perform: async () => {
      sent++;
      if (mode === 'unknown') throw new OutcomeUnknownError('no answer from seller');
      if (mode === 'definite') throw new Error('seller said no');
      return { status: 201, body: { order: 'ORD-1' } };
    },
    ...over,
  });
  return { gate, req, get sent() { return sent; }, setMode: (m: typeof mode) => { mode = m; } };
}

async function approvalFor(h: ReturnType<typeof unknownHarness>) {
  const r = await h.gate.handle(h.req());
  assert.equal(r.kind, 'approval_required');
  const op = (r as { operation: { operation_id: string; revision: string } }).operation;
  return { operation_id: op.operation_id, revision: op.revision };
}

test('unknown outcome: answers in_progress and NEVER performs again on retry', async () => {
  const h = unknownHarness();
  const approval = await approvalFor(h);
  const r1 = await h.gate.handle(h.req({ approval }));
  assert.equal(r1.kind, 'in_progress');
  for (let i = 0; i < 3; i++) assert.equal((await h.gate.handle(h.req({ approval }))).kind, 'in_progress');
  assert.equal((await h.gate.handle(h.req())).kind, 'in_progress', 'a fresh request for the same action must not start a new order');
  assert.equal(h.sent, 1);
  const rec = h.gate.get(approval.operation_id)!;
  assert.equal(rec.state, 'performing');
  assert.ok(rec.unknown);
});

test('settle() records the real outcome; later approvals replay it', async () => {
  const h = unknownHarness();
  const approval = await approvalFor(h);
  await h.gate.handle(h.req({ approval }));
  assert.equal(h.gate.unresolved().length, 1);
  assert.equal(h.gate.settle(approval.operation_id, { status: 201, body: { order: 'ORD-9' } }), true);
  assert.equal(h.gate.unresolved().length, 0);
  const r = await h.gate.handle(h.req({ approval }));
  assert.equal(r.kind, 'performed');
  assert.deepEqual((r as { response: unknown }).response, { status: 201, body: { order: 'ORD-9' } });
  assert.equal(h.sent, 1);
});

test('release() frees an operation the seller refused; the approval can be used again', async () => {
  const h = unknownHarness();
  const approval = await approvalFor(h);
  await h.gate.handle(h.req({ approval }));
  assert.equal(h.gate.release(approval.operation_id), true);
  h.setMode('ok');
  const r = await h.gate.handle(h.req({ approval }));
  assert.equal(r.kind, 'performed');
  assert.equal(h.sent, 2);
});

test('a definite failure still frees the approval for a retry', async () => {
  const h = unknownHarness();
  h.setMode('definite');
  const approval = await approvalFor(h);
  await assert.rejects(h.gate.handle(h.req({ approval })), /seller said no/);
  assert.equal(h.gate.get(approval.operation_id)!.state, 'pending');
  h.setMode('ok');
  assert.equal((await h.gate.handle(h.req({ approval }))).kind, 'performed');
});

test('settle()/release() refuse operations that are not waiting for an outcome', async () => {
  const h = unknownHarness();
  const approval = await approvalFor(h);
  assert.equal(h.gate.settle(approval.operation_id, { status: 201, body: {} }), false);
  assert.equal(h.gate.release(approval.operation_id), false);
  assert.equal(h.gate.settle('op_does_not_exist', { status: 201, body: {} }), false);
});
