import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { formatRemoteObject } from '../src/lib/format.js';
import type { GetPropertiesFn } from '../src/lib/types.js';

const noProps: GetPropertiesFn = async () => ({ result: [] });

test('formatRemoteObject: scalar string', async () => {
  const r = await formatRemoteObject({ type: 'string', value: 'hello' }, noProps);
  assert.equal(r, 'hello');
});

test('formatRemoteObject: number/boolean/bigint passthrough', async () => {
  const num = await formatRemoteObject({ type: 'number', value: 42 }, noProps);
  const bool = await formatRemoteObject({ type: 'boolean', value: true }, noProps);
  assert.equal(num, 42);
  assert.equal(bool, true);
});

test('formatRemoteObject: undefined is undefined', async () => {
  const r = await formatRemoteObject({ type: 'undefined' }, noProps);
  assert.equal(r, undefined);
});

test('formatRemoteObject: null subtype', async () => {
  const r = await formatRemoteObject({ type: 'object', subtype: 'null' }, noProps);
  assert.equal(r, null);
});

test('formatRemoteObject: long string truncation', async () => {
  const big = 'a'.repeat(1000);
  const r = await formatRemoteObject(
    { type: 'string', value: big },
    noProps,
    { maxString: 10 },
  );
  const out = r as string;
  assert.ok(out.includes('...[truncated'), out);
  assert.ok(out.length < big.length);
});

test('formatRemoteObject: object with nested props (depth 2)', async () => {
  const getProps: GetPropertiesFn = async (objectId) => {
    if (objectId === 'outer') {
      return {
        result: [
          {
            name: 'inner',
            value: { type: 'object', objectId: 'inner', description: 'Object' },
            configurable: true,
            enumerable: true,
            writable: true,
            isOwn: true,
          },
        ],
      };
    }
    if (objectId === 'inner') {
      return {
        result: [
          {
            name: 'leaf',
            value: { type: 'string', value: 'gold' },
            configurable: true,
            enumerable: true,
            writable: true,
            isOwn: true,
          },
        ],
      };
    }
    return { result: [] };
  };

  const r = (await formatRemoteObject(
    { type: 'object', objectId: 'outer', description: 'Object' },
    getProps,
    { depth: 3 },
  )) as { inner: { leaf: string } };

  assert.equal(r.inner.leaf, 'gold');
});

test('formatRemoteObject: circular ref handled (no infinite recursion)', async () => {
  const getProps: GetPropertiesFn = async () => ({
    result: [
      {
        name: 'self',
        value: { type: 'object', objectId: 'cycle', description: 'Object' },
        configurable: true,
        enumerable: true,
        writable: true,
        isOwn: true,
      },
    ],
  });

  const r = (await formatRemoteObject(
    { type: 'object', objectId: 'cycle', description: 'Object' },
    getProps,
    { depth: 5 },
  )) as { self: { __circular: boolean } };
  assert.equal(r.self.__circular, true);
});

test('formatRemoteObject: respects depth=0 (preview only)', async () => {
  const r = await formatRemoteObject(
    {
      type: 'object',
      objectId: 'x',
      description: 'Object',
      preview: { type: 'object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }] },
    } as unknown as Protocol.Runtime.RemoteObject,
    noProps,
    { depth: 0 },
  );
  assert.deepEqual(r, { a: '1' });
});
