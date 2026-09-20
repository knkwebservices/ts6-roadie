import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { dialFileTransfer } from '@echosixhiya/teamspeak-client';
import { applyAvatar, AvatarError, clearAvatar, detectImage, MAX_AVATAR_BYTES, md5Hex, type AvatarIo } from '../src/adapter/avatar.js';
import { hostFromAddress, sendOverTransfer } from '../src/adapter/filetransfer.js';

const PNG = readFileSync(resolve(import.meta.dirname, '../assets/roadie-avatar.png'));

/** A recording fake of everything the avatar logic needs from a TeamSpeak session. */
function fakeIo(over: Partial<AvatarIo<string>> = {}) {
  const calls: string[] = [];
  const io: AvatarIo<string> = {
    currentHash: async () => {
      calls.push('currentHash');
      return '';
    },
    initUpload: async (size) => {
      calls.push(`initUpload:${size}`);
      return 'ticket';
    },
    send: async (ticket, bytes) => {
      calls.push(`send:${ticket}:${bytes.length}`);
    },
    setFlag: async (hash) => {
      calls.push(`setFlag:${hash}`);
    },
    ...over,
  };
  return { io, calls };
}

test('md5 matches a known test vector', () => {
  assert.equal(md5Hex(Buffer.from('abc')), '900150983cd24fb0d6963f7d28e17f72');
});

test('the bundled avatar is a real image within sensible limits', () => {
  assert.equal(detectImage(PNG), 'png');
  assert.ok(PNG.length > 500 && PNG.length < 100_000, `unexpected size ${PNG.length}`);
});

test('detectImage recognises PNG, JPEG and GIF and nothing else', () => {
  assert.equal(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpeg');
  assert.equal(detectImage(Buffer.from('GIF89a......')), 'gif');
  assert.equal(detectImage(Buffer.from('GIF87a......')), 'gif');
  assert.equal(detectImage(Buffer.from('<html>not an image</html>')), undefined);
  assert.equal(detectImage(Buffer.from('PK\u0003\u0004zipfile')), undefined);
  assert.equal(detectImage(Buffer.alloc(0)), undefined);
});

test('upload happens in the right order: slot, bytes, THEN the hash flag', async () => {
  const { io, calls } = fakeIo();
  const r = await applyAvatar(io, PNG);
  assert.equal(r.status, 'uploaded');
  assert.equal(r.md5, md5Hex(PNG));
  assert.equal(r.bytes, PNG.length);
  assert.deepEqual(calls, ['currentHash', `initUpload:${PNG.length}`, `send:ticket:${PNG.length}`, `setFlag:${md5Hex(PNG)}`]);
});

test('nothing is uploaded when the server already shows this exact image (any hex case)', async () => {
  const { io, calls } = fakeIo({ currentHash: async () => md5Hex(PNG).toUpperCase() });
  const r = await applyAvatar(io, PNG);
  assert.equal(r.status, 'unchanged');
  assert.deepEqual(calls, []); // no slot, no bytes, no flag
});

test('force uploads even when unchanged', async () => {
  const { io, calls } = fakeIo({ currentHash: async () => md5Hex(PNG) });
  const r = await applyAvatar(io, PNG, { force: true });
  assert.equal(r.status, 'uploaded');
  assert.ok(calls.some((c) => c.startsWith('send:')));
});

test('a different avatar, or one we are not allowed to read, still uploads', async () => {
  for (const currentHash of [async () => 'deadbeef', async () => '', async (): Promise<string | undefined> => undefined]) {
    const { io, calls } = fakeIo({ currentHash });
    assert.equal((await applyAvatar(io, PNG)).status, 'uploaded');
    assert.ok(calls.includes(`setFlag:${md5Hex(PNG)}`));
  }
  const { io } = fakeIo({
    currentHash: async () => {
      throw new Error('no permission');
    },
  });
  assert.equal((await applyAvatar(io, PNG)).status, 'uploaded');
});

test('bad files are rejected BEFORE anything is sent to the server', async () => {
  for (const [bad, why] of [
    [Buffer.alloc(0), /empty/],
    [Buffer.from('hello, I am a text file'), /not a PNG, JPEG or GIF/],
    [Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]), /too big/],
  ] as const) {
    const { io, calls } = fakeIo();
    await assert.rejects(applyAvatar(io, bad), (e: Error) => e instanceof AvatarError && why.test(e.message));
    assert.deepEqual(calls, [], 'the server must not be contacted for a bad file');
  }
});

test('if the server refuses the upload, the reason is shown and nothing else happens', async () => {
  const { io, calls } = fakeIo({
    initUpload: async () => {
      throw new Error('TeamSpeak server error: insufficient client permissions (id=2568)');
    },
  });
  await assert.rejects(applyAvatar(io, PNG), /refused the upload.*insufficient client permissions \(id=2568\)/);
  assert.ok(!calls.some((c) => c.startsWith('send:') || c.startsWith('setFlag:')));
});

test('SAFETY: if sending fails, the avatar hash is never set', async () => {
  const { io, calls } = fakeIo({
    send: async () => {
      throw new Error('could not reach the server\'s file-transfer port (TCP 30033)');
    },
  });
  await assert.rejects(applyAvatar(io, PNG), /upload failed.*30033/);
  assert.ok(!calls.some((c) => c.startsWith('setFlag:')), 'the hash must not point at a file that never arrived');
});

test('if only the final switch fails, the message says the image did upload', async () => {
  const { io } = fakeIo({
    setFlag: async () => {
      throw new Error('boom');
    },
  });
  await assert.rejects(applyAvatar(io, PNG), /was uploaded, but the server would not switch.*boom/);
});

test('clearing resets the hash to empty, and reports failures', async () => {
  const seen: string[] = [];
  await clearAvatar({ setFlag: async (h) => void seen.push(h) });
  assert.deepEqual(seen, ['']);
  await assert.rejects(
    clearAvatar({
      setFlag: async () => {
        throw new Error('nope');
      },
    }),
    /could not clear the avatar.*nope/,
  );
});

test('hostFromAddress', () => {
  assert.equal(hostFromAddress('tgscgo.net:9987'), 'tgscgo.net');
  assert.equal(hostFromAddress('tgscgo.net'), 'tgscgo.net');
  assert.equal(hostFromAddress('  10.1.2.3:9987 '), '10.1.2.3');
  assert.equal(hostFromAddress('[::1]:9987'), '::1');
  assert.equal(hostFromAddress('2001:db8::1'), '2001:db8::1');
});

// ---- the real TCP transfer, against a local stand-in for the server's file-transfer port ----------------

interface FakeFtServer {
  server: Server;
  port: number;
  received: Buffer[];
  sockets: Socket[];
}

async function fakeFtServer(behaviour: (s: Socket, state: FakeFtServer) => void, opts: { allowHalfOpen?: boolean } = {}): Promise<FakeFtServer> {
  const state = { received: [], sockets: [] } as unknown as FakeFtServer;
  // By default Node closes its side as soon as the client finishes sending (like a server that stores the file and hangs up).
  state.server = createServer({ allowHalfOpen: opts.allowHalfOpen ?? false }, (s) => {
    state.sockets.push(s);
    s.on('error', () => {});
    behaviour(s, state);
  });
  await new Promise<void>((r) => state.server.listen(0, '127.0.0.1', r));
  state.port = (state.server.address() as { port: number }).port;
  return state;
}
const closeAll = (st: FakeFtServer) => {
  for (const s of st.sockets) s.destroy();
  st.server.close();
};

test('transfer: sends key then file, and finishes as soon as the server closes', async () => {
  const KEY = 'abcdefghijklmnopqrstuvwxyz012345'; // transfer keys are 32 characters
  const st = await fakeFtServer((s, state) => {
    s.on('data', (d) => {
      state.received.push(d);
      if (Buffer.concat(state.received).length >= KEY.length + PNG.length) s.end(); // "stored it"
    });
  });
  try {
    const t0 = Date.now();
    await sendOverTransfer(dialFileTransfer, '127.0.0.1', { port: st.port, key: KEY }, PNG, { closeWaitMs: 5_000 });
    assert.ok(Date.now() - t0 < 2_000, 'should return when the server closes, not after the 5s wait');
    const got = Buffer.concat(st.received);
    assert.equal(got.subarray(0, KEY.length).toString(), KEY, 'the key must come first');
    assert.ok(got.subarray(KEY.length).equals(PNG), 'the file bytes must arrive intact after the key');
  } finally {
    closeAll(st);
  }
});

test('transfer: a server that never closes does not hang us; we carry on after the wait', async () => {
  // allowHalfOpen: the server keeps its side open after we finish, like one that never hangs up
  const st = await fakeFtServer((s, state) => s.on('data', (d) => state.received.push(d)), { allowHalfOpen: true });
  try {
    const t0 = Date.now();
    await sendOverTransfer(dialFileTransfer, '127.0.0.1', { port: st.port, key: 'k'.repeat(32) }, PNG, { closeWaitMs: 300 });
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 2_000, `took ${took}ms`);
    assert.ok(Buffer.concat(st.received).length >= PNG.length);
  } finally {
    closeAll(st);
  }
});

test('transfer: a server that hangs up before we finish is reported as a failure', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(3_000_000, 1)]);
  const st = await fakeFtServer((s) => s.destroy());
  try {
    await assert.rejects(sendOverTransfer(dialFileTransfer, '127.0.0.1', { port: st.port, key: 'k'.repeat(32) }, big, { closeWaitMs: 300, totalMs: 5_000 }));
  } finally {
    closeAll(st);
  }
});

test('transfer: an unreachable port gives a message that says which port and to check the firewall', async () => {
  const st = await fakeFtServer(() => {});
  const port = st.port;
  closeAll(st); // now nothing is listening there
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    sendOverTransfer(dialFileTransfer, '127.0.0.1', { port, key: 'k'.repeat(32) }, PNG),
    (e: Error) => e.message.includes(`TCP ${port}`) && /file-transfer port/.test(e.message) && /firewall/.test(e.message),
  );
});
