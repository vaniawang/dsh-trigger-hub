import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseCron, nextCronTime, scheduleOf, delayUntilNext } from '../src/schedule.js';

test('parseDuration accepts s/m/h/d', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('6h'), 21_600_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.throws(() => parseDuration('5'), /invalid duration/);
  assert.throws(() => parseDuration('0s'), /at least 1s/);
});

test('parseCron validates five fields and expands steps', () => {
  const cron = parseCron('*/15 9-17 * * 1-5');
  assert.deepEqual([...cron.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...cron.hours].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(cron.daysOfWeek.has(1), true);
  assert.throws(() => parseCron('* * * *'), /five fields/);
  assert.throws(() => parseCron('60 * * * *'), /outside 0-59/);
});

test('nextCronTime finds the next matching minute', () => {
  const from = new Date('2026-11-02T08:30:00');
  const next = nextCronTime('0 9 * * *', from);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 2);

  const weekly = nextCronTime('0 9 * * 1', new Date('2026-11-02T10:00:00'));
  assert.equal(weekly.getDay(), 1);
  assert.equal(weekly.getHours(), 9);
});

test('scheduleOf requires exactly one of cron/every', () => {
  assert.deepEqual(scheduleOf({ id: 'a', every: '2h' }), { kind: 'interval', ms: 7_200_000 });
  assert.equal(scheduleOf({ id: 'b', cron: '0 * * * *' }).kind, 'cron');
  assert.throws(() => scheduleOf({ id: 'c' }), /needs cron or every/);
  assert.throws(() => scheduleOf({ id: 'd', cron: '0 * * * *', every: '1h' }), /either cron or every/);
});

test('delayUntilNext returns a positive delay', () => {
  const delay = delayUntilNext({ id: 'a', every: '90s' }, new Date());
  assert.equal(delay, 90_000);
  const cronDelay = delayUntilNext({ id: 'b', cron: '0 0 1 1 *' }, new Date('2026-11-02T00:00:00'));
  assert.ok(cronDelay > 0);
});
