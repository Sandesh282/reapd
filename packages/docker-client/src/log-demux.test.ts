import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { demuxDockerLogs, type LogFrame } from './log-demux.js';

function frame(type: number, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function collect(chunks: Buffer[]): Promise<LogFrame[]> {
  const out: LogFrame[] = [];
  for await (const f of demuxDockerLogs(Readable.from(chunks))) out.push(f);
  return out;
}

test('demuxes stdout and stderr frames', async () => {
  const out = await collect([frame(1, 'hello\n'), frame(2, 'boom\n')]);
  assert.deepEqual(out.map((f) => [f.stream, f.text]), [['stdout', 'hello'], ['stderr', 'boom']]);
});

test('reassembles a frame split mid-header and mid-payload', async () => {
  const whole = Buffer.concat([frame(1, 'split-me\n'), frame(2, 'second\n')]);
  const chunks = [whole.subarray(0, 3), whole.subarray(3, 12), whole.subarray(12)];
  const out = await collect(chunks);
  assert.deepEqual(out.map((f) => f.text), ['split-me', 'second']);
});

test('skips a whole stdin (0x00) frame without desyncing', async () => {
  const out = await collect([frame(0, 'ignored-input'), frame(1, 'after\n')]);
  assert.deepEqual(out.map((f) => f.text), ['after']);
});

