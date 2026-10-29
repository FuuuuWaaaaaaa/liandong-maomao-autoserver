import net from 'node:net';

function varInt(value: number): Buffer {
  const bytes: number[] = [];
  let current = value >>> 0;
  do {
    let next = current & 0x7f;
    current >>>= 7;
    if (current !== 0) next |= 0x80;
    bytes.push(next);
  } while (current !== 0);
  return Buffer.from(bytes);
}

function stringValue(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([varInt(bytes.length), bytes]);
}

function readVarInt(buffer: Buffer, offset: number): { value: number; nextOffset: number } | undefined {
  let value = 0;
  let position = offset;
  let shift = 0;
  while (position < buffer.length && shift < 35) {
    const byte = buffer[position++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, nextOffset: position };
    shift += 7;
  }
  return undefined;
}

function isStatusResponse(buffer: Buffer): boolean {
  const packet = readVarInt(buffer, 0);
  if (!packet || packet.value > 1_048_576 || buffer.length < packet.nextOffset + packet.value) return false;
  const packetEnd = packet.nextOffset + packet.value;
  const packetId = readVarInt(buffer, packet.nextOffset);
  if (!packetId || packetId.value !== 0) return false;
  const jsonLength = readVarInt(buffer, packetId.nextOffset);
  if (!jsonLength || jsonLength.value < 2 || jsonLength.nextOffset + jsonLength.value > packetEnd) return false;
  try {
    const payload = JSON.parse(buffer.toString('utf8', jsonLength.nextOffset, jsonLength.nextOffset + jsonLength.value)) as { version?: unknown; players?: unknown; description?: unknown };
    return typeof payload === 'object' && payload !== null && ('version' in payload || 'players' in payload || 'description' in payload);
  } catch {
    return false;
  }
}

/** Performs the Minecraft status handshake without joining the server. */
export function probeMinecraft(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once('error', () => { clearTimeout(timeout); finish(false); });
    socket.once('timeout', () => { clearTimeout(timeout); finish(false); });
    socket.on('data', (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 1_048_576) { clearTimeout(timeout); finish(false); return; }
      if (isStatusResponse(response)) { clearTimeout(timeout); finish(true); }
    });
    socket.connect(port, host, () => {
      const handshake = Buffer.concat([varInt(0), varInt(0), stringValue(host), Buffer.from([(port >>> 8) & 0xff, port & 0xff]), varInt(1)]);
      const request = Buffer.concat([varInt(1), Buffer.from([0])]);
      socket.write(Buffer.concat([varInt(handshake.length), handshake, request]));
    });
    socket.setTimeout(timeoutMs);
  });
}
