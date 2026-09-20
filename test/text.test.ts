import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText, formatDuration, parseCommandLine, stripBbcode } from '../src/util/text.js';

test('stripBbcode unwraps TeamSpeak link markup', () => {
  assert.equal(stripBbcode('!play [URL]https://youtu.be/abc[/URL]'), '!play https://youtu.be/abc');
  assert.equal(stripBbcode('!play [URL=https://a.b/c]click here[/URL]'), '!play https://a.b/c');
  assert.equal(stripBbcode('[B]!ping[/B]'), '!ping');
  assert.equal(stripBbcode('!play song [1]'), '!play song [1]'); // not BBCode
});

test('parseCommandLine', () => {
  assert.deepEqual(parseCommandLine('!Play never gonna  give you up', '!'), {
    name: 'play',
    args: ['never', 'gonna', 'give', 'you', 'up'],
    rest: 'never gonna  give you up',
  });
  assert.deepEqual(parseCommandLine('!ping', '!'), { name: 'ping', args: [], rest: '' });
  assert.equal(parseCommandLine('hello', '!'), null);
  assert.equal(parseCommandLine('!', '!'), null);
  assert.equal(parseCommandLine('! ', '!'), null);
  assert.equal(parseCommandLine('.play x', '.')?.name, 'play');
});

test('chunkText keeps every piece under the limit and loses nothing', () => {
  const long = Array.from({ length: 200 }, (_, i) => `line number ${i}`).join('\n');
  const parts = chunkText(long, 300);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 300));
  assert.equal(parts.join('\n'), long);
  const oneHugeLine = 'word '.repeat(500).trim();
  const p2 = chunkText(oneHugeLine, 100);
  assert.ok(p2.every((p) => p.length <= 100));
  assert.equal(p2.join(' ').replace(/\s+/g, ' '), oneHugeLine);
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(undefined), 'live');
});
