import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorEventDiscriminator, decodePumpEvent, parsePumpLogs } from '../src/stream/events.js';
import { createTxLogs, encodeCreateEvent, encodeTradeEvent, key, tradeTxLogs } from './fixtures/pump-logs.js';

test('discriminateurs d’événements Anchor Pump.fun', () => {
  assert.deepEqual([...anchorEventDiscriminator('CreateEvent')], [27, 114, 169, 77, 222, 235, 99, 118]);
  assert.deepEqual([...anchorEventDiscriminator('TradeEvent')], [189, 219, 127, 211, 78, 230, 97, 238]);
});

test('CreateEvent : format récent (creator + réserves) et format historique', () => {
  const mint = key();
  const user = key();
  const recent = decodePumpEvent(Buffer.from(encodeCreateEvent({ name: 'Moon Cat', symbol: 'MCAT', mint, user }), 'base64'));
  assert.equal(recent?.kind, 'create');
  if (recent?.kind === 'create') {
    assert.equal(recent.name, 'Moon Cat');
    assert.equal(recent.symbol, 'MCAT');
    assert.equal(recent.mint, mint);
    assert.equal(recent.creator, user);
    assert.equal(recent.tokenTotalSupply, 1_000_000_000_000_000n);
  }
  const legacy = decodePumpEvent(Buffer.from(encodeCreateEvent({ name: 'Old', symbol: 'OLD', mint, user, legacy: true }), 'base64'));
  assert.equal(legacy?.kind === 'create' && legacy.creator, user);
});

test('TradeEvent : montants, sens et acheteur', () => {
  const mint = key();
  const user = key();
  const event = decodePumpEvent(Buffer.from(encodeTradeEvent({ mint, user, isBuy: false, sol: 123n, tokens: 456n }), 'base64'));
  assert.equal(event?.kind, 'trade');
  if (event?.kind === 'trade') {
    assert.equal(event.mint, mint);
    assert.equal(event.user, user);
    assert.equal(event.isBuy, false);
    assert.equal(event.solAmount, 123n);
    assert.equal(event.tokenAmount, 456n);
  }
});

test('données invalides ou tronquées : null, jamais d’exception', () => {
  assert.equal(decodePumpEvent(Buffer.alloc(4)), null);
  const truncated = Buffer.from(encodeTradeEvent({ mint: key(), user: key(), isBuy: true, sol: 1n, tokens: 1n }), 'base64').subarray(0, 50);
  assert.equal(decodePumpEvent(truncated), null);
});

test('parsePumpLogs : création + achat du dev dans la même transaction', () => {
  const mint = key();
  const creator = key();
  const parsed = parsePumpLogs(createTxLogs({ mint, creator, devBuyTokens: 50_000_000_000_000n }));
  assert.equal(parsed.sawCreate, true);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.events.map((e) => e.kind), ['create', 'trade']);
});

test('parsePumpLogs : un événement homonyme émis par un autre programme est ignoré', () => {
  const foreign = key();
  const logs = [
    `Program ${foreign} invoke [1]`,
    `Program data: ${encodeTradeEvent({ mint: key(), user: key(), isBuy: true, sol: 1n, tokens: 1n })}`,
    `Program ${foreign} success`,
    ...tradeTxLogs({ mint: key(), user: key() }),
  ];
  assert.equal(parsePumpLogs(logs).events.length, 1);
});

test('parsePumpLogs : un "Program log: success" ne dépile pas la pile d’appels', () => {
  const mint = key();
  const logs = tradeTxLogs({ mint, user: key() });
  logs.splice(2, 0, 'Program log: success');
  assert.equal(parsePumpLogs(logs).events.length, 1);
});

test('parsePumpLogs : logs tronqués → création détectée sans événement', () => {
  const parsed = parsePumpLogs(createTxLogs({ mint: key(), creator: key(), truncated: true }));
  assert.equal(parsed.sawCreate, true);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.events.length, 0);
});
