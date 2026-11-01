// packages/docker-client/src/log-demux.ts
//
// Docker Engine API log stream demultiplexer.
//
// When a container is started with Tty: false (which preserves distinct stdout
// and stderr channels), Docker multiplexes both streams over a single HTTP
// hijacked connection using an 8-byte binary header per frame:
//
//   Byte 0:    Stream type — 0x01 = stdout, 0x02 = stderr (0x00 = stdin, ignored)
//   Bytes 1–3: Zero padding
//   Bytes 4–7: Payload length N as an unsigned 32-bit big-endian integer
//   Bytes 8…:  N bytes of UTF-8 payload
//
// CRITICAL: TCP may split a single frame header (or payload) across multiple
// 'data' events. This implementation uses a Buffer accumulator that loops
// until a complete frame is available before yielding — never assumes that
// one 'data' event = one complete frame.

const HEADER_SIZE = 8;

export type LogStreamType = 'stdout' | 'stderr';

export interface LogFrame {
  stream: LogStreamType;
  text: string;
  timestampMs: number;
}

/**
 * Async generator that reads Docker's multiplexed log stream and yields
 * individual demultiplexed log frames.
 *
 * @param stream  A Node.js Readable from `container.logs({ follow: true, tty: false })`
 *
 * @example
 * const logStream = await container.logs({ follow: true, stdout: true, stderr: true, tty: false });
 * for await (const frame of demuxDockerLogs(logStream)) {
 *   console.log(`[${frame.stream}] ${frame.text}`);
 * }
 */
export async function* demuxDockerLogs(
  stream: NodeJS.ReadableStream
): AsyncGenerator<LogFrame> {
  let buffer = Buffer.alloc(0);

  for await (const chunk of stream) {
    // Accumulate incoming TCP chunks into a contiguous buffer
    buffer = Buffer.concat([buffer, chunk as Buffer]);

    // Process as many complete frames as the buffer contains
    while (buffer.length >= HEADER_SIZE) {
      // Read stream type from byte 0
      const streamByte = buffer[0];
      const hasZeroPadding = buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0;

      if (
        (streamByte !== 0x00 && streamByte !== 0x01 && streamByte !== 0x02) ||
        !hasZeroPadding
      ) {
        // Misaligned/corrupt header — discard one byte and try re-syncing
        buffer = buffer.subarray(1);
        continue;
      }

      // Read payload length from bytes 4–7 (big-endian uint32)
      const payloadLength = buffer.readUInt32BE(4);

      // Wait until we have the full frame payload in the buffer
      if (buffer.length < HEADER_SIZE + payloadLength) break;

      if (streamByte === 0x00) {
        // Valid stdin frame: skip the whole frame, payload included
        buffer = buffer.subarray(HEADER_SIZE + payloadLength);
        continue;
      }

      const payload = buffer
        .subarray(HEADER_SIZE, HEADER_SIZE + payloadLength)
        .toString('utf8');

      // Advance buffer past this frame
      buffer = buffer.subarray(HEADER_SIZE + payloadLength);

      const stream: LogStreamType = streamByte === 0x01 ? 'stdout' : 'stderr';

      // Split on newlines — a single Docker frame can contain multiple lines
      for (const line of payload.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0) {
          yield {
            stream,
            text: trimmed,
            timestampMs: Date.now(),
          };
        }
      }
    }
  }
}

