import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// SPECK overnight Group 3: /api/repair-webm is the server-side webm
// container fix that fires as a last-resort fallback when client-side
// repairWebmDuration + finalizeWebmDuration both fail.
//
// We can't easily run the full Next.js route handler under node:test
// without a Next request shim, and we can't invoke ffmpeg cleanly in a
// unit-test fixture either. These tests pin the contract surface —
// validation of the request body and the shape of the success/error
// JSON — by exercising the route handler with hand-rolled NextRequest
// stubs. The ffmpeg-spawn happy path is covered by browser-side
// validation; here we mock node:child_process.spawn so the test
// suite stays hermetic and offline.

// Important: we install the child_process mock BEFORE importing the
// route. The route's module-level `import { spawn } from 'node:child_process'`
// will then receive the mocked function.

type SpawnArgs = Parameters<typeof import('node:child_process').spawn>;

function mockChildProcess(
  behavior: 'ok' | 'enoent' | 'nonzero' | 'timeout' | 'empty',
): void {
  // Build a fake ChildProcess-shape object. The route only consumes
  // stdout 'data'/stdin/stderr/error/close events, kill(), so we shim
  // just those.
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  cp.__realSpawn = realSpawn;
  cp.spawn = (..._args: SpawnArgs) => {
    const listeners: Record<string, Array<(arg: unknown, arg2?: unknown) => void>> = {};
    const stdoutListeners: Array<(chunk: Buffer) => void> = [];
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const child = {
      stdin: {
        end: () => { /* no-op */ },
      },
      stdout: {
        on: (_e: 'data', cb: (chunk: Buffer) => void) => stdoutListeners.push(cb),
      },
      stderr: {
        on: (_e: 'data', cb: (chunk: Buffer) => void) => stderrListeners.push(cb),
      },
      on: (event: string, cb: (arg: unknown, arg2?: unknown) => void) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event]!.push(cb);
      },
      kill: () => { /* no-op */ },
    };
    // Drive the simulated child asynchronously so the route's promise
    // setup completes before we fire events. setImmediate is enough.
    setImmediate(() => {
      if (behavior === 'enoent') {
        const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
        listeners.error?.forEach((cb) => cb(err));
        return;
      }
      if (behavior === 'timeout') {
        // Never resolve — the route's internal timeout will fire.
        return;
      }
      if (behavior === 'ok') {
        const fakeOut = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]); // a few EBML bytes
        stdoutListeners.forEach((cb) => cb(fakeOut));
        listeners.close?.forEach((cb) => cb(0, null));
        return;
      }
      if (behavior === 'empty') {
        // Exit 0 but no stdout.
        listeners.close?.forEach((cb) => cb(0, null));
        return;
      }
      if (behavior === 'nonzero') {
        stderrListeners.forEach((cb) => cb(Buffer.from('ffmpeg: invalid data\n')));
        listeners.close?.forEach((cb) => cb(1, null));
      }
    });
    return child;
  };
}

function restoreChildProcess() {
  const cp = require('node:child_process');
  if (cp.__realSpawn) {
    cp.spawn = cp.__realSpawn;
    delete cp.__realSpawn;
  }
}

// Minimal NextRequest stub — the route only awaits req.json().
function fakeReq(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

describe('/api/repair-webm — request validation', () => {
  it('returns 400 when the body is not valid JSON', async () => {
    const { POST } = await import('../app/api/repair-webm/route.ts');
    const req = {
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as import('next/server').NextRequest;
    const res = await POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid JSON/);
  });

  it('returns 400 when webmBase64 is missing', async () => {
    const { POST } = await import('../app/api/repair-webm/route.ts');
    const res = await POST(fakeReq({}));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /missing webmBase64/);
  });

  it('returns 400 when webmBase64 is empty string', async () => {
    const { POST } = await import('../app/api/repair-webm/route.ts');
    const res = await POST(fakeReq({ webmBase64: '' }));
    assert.equal(res.status, 400);
  });

  it('returns 400 when webmBase64 decodes to empty bytes', async () => {
    const { POST } = await import('../app/api/repair-webm/route.ts');
    // Empty base64-encodes to empty.
    const res = await POST(fakeReq({ webmBase64: '====' }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /empty/);
  });

  it('returns 413 when the base64 payload exceeds the cap', async () => {
    const { POST } = await import('../app/api/repair-webm/route.ts');
    // 20MB+1 byte string trips MAX_INPUT_BASE64_LEN.
    const huge = 'a'.repeat(20 * 1024 * 1024 + 1);
    const res = await POST(fakeReq({ webmBase64: huge }));
    assert.equal(res.status, 413);
  });
});

describe('/api/repair-webm — ffmpeg spawn outcomes', () => {
  it('returns 500 with reason=spawn-enoent when ffmpeg is not on PATH', async () => {
    mockChildProcess('enoent');
    try {
      const { POST } = await import('../app/api/repair-webm/route.ts');
      const validBase64 = Buffer.from('any non-empty bytes').toString('base64');
      const res = await POST(fakeReq({ webmBase64: validBase64 }));
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.reason, 'spawn-enoent');
    } finally {
      restoreChildProcess();
    }
  });

  it('returns 500 with reason=nonzero-exit when ffmpeg exits non-zero', async () => {
    mockChildProcess('nonzero');
    try {
      const { POST } = await import('../app/api/repair-webm/route.ts');
      const validBase64 = Buffer.from('garbage but non-empty').toString('base64');
      const res = await POST(fakeReq({ webmBase64: validBase64 }));
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.reason, 'nonzero-exit');
    } finally {
      restoreChildProcess();
    }
  });

  it('returns 500 with reason=empty-output when ffmpeg succeeds but writes nothing', async () => {
    mockChildProcess('empty');
    try {
      const { POST } = await import('../app/api/repair-webm/route.ts');
      const validBase64 = Buffer.from('garbage but non-empty').toString('base64');
      const res = await POST(fakeReq({ webmBase64: validBase64 }));
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.reason, 'empty-output');
    } finally {
      restoreChildProcess();
    }
  });

  it('returns 200 with webmBase64 + byte counts on the happy path', async () => {
    mockChildProcess('ok');
    try {
      const { POST } = await import('../app/api/repair-webm/route.ts');
      const validBase64 = Buffer.from('any non-empty bytes').toString('base64');
      const res = await POST(fakeReq({ webmBase64: validBase64 }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.webmBase64, 'string');
      assert.ok(body.webmBase64.length > 0);
      assert.equal(typeof body.bytesBefore, 'number');
      assert.equal(typeof body.bytesAfter, 'number');
      assert.ok(body.bytesAfter > 0, 'bytesAfter must be positive when ok');
    } finally {
      restoreChildProcess();
    }
  });
});
