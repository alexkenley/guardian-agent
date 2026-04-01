import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { readBody, readJsonBody, readOptionalJsonBody, sendJSON } from './web-json.js';

describe('sendJSON', () => {
  it('writes a JSON response when headers have not been sent', () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const res = {
      headersSent: false,
      writeHead,
      end,
    } as unknown as ServerResponse;

    sendJSON(res, 201, { ok: true });

    expect(writeHead).toHaveBeenCalledWith(201, { 'Content-Type': 'application/json' });
    expect(end).toHaveBeenCalledWith('{"ok":true}');
  });

  it('does nothing when headers were already sent', () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const res = {
      headersSent: true,
      writeHead,
      end,
    } as unknown as ServerResponse;

    sendJSON(res, 200, { ok: true });

    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});

describe('readBody', () => {
  it('reads the full request body', async () => {
    const req = new PassThrough() as PassThrough & IncomingMessage;

    const bodyPromise = readBody(req as IncomingMessage, 1024);
    req.write('hello ');
    req.end('world');

    await expect(bodyPromise).resolves.toBe('hello world');
  });

  it('rejects requests that exceed the size limit', async () => {
    const req = new PassThrough() as PassThrough & IncomingMessage;
    const destroy = vi.spyOn(req, 'destroy');

    const bodyPromise = readBody(req as IncomingMessage, 4);
    req.write('hello');

    await expect(bodyPromise).rejects.toThrow('Request body too large (limit: 4 bytes)');
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('readJsonBody', () => {
  it('parses a JSON request body', async () => {
    const req = new PassThrough() as PassThrough & IncomingMessage;

    const bodyPromise = readJsonBody<{ action: string }>(req as IncomingMessage, 1024);
    req.end('{"action":"rotate"}');

    await expect(bodyPromise).resolves.toEqual({ action: 'rotate' });
  });

  it('rejects invalid JSON payloads', async () => {
    const req = new PassThrough() as PassThrough & IncomingMessage;

    const bodyPromise = readJsonBody<{ action: string }>(req as IncomingMessage, 1024);
    req.end('{invalid');

    await expect(bodyPromise).rejects.toThrow('Invalid JSON');
  });
});

describe('readOptionalJsonBody', () => {
  it('returns the provided empty value for blank bodies', async () => {
    const req = new PassThrough() as PassThrough & IncomingMessage;

    const bodyPromise = readOptionalJsonBody(req as IncomingMessage, 1024, { ticket: undefined as string | undefined });
    req.end('   ');

    await expect(bodyPromise).resolves.toEqual({ ticket: undefined });
  });

  it('parses JSON when content is present', async () => {
    const req = new PassThrough() as PassThrough & IncomingMessage;

    const bodyPromise = readOptionalJsonBody(req as IncomingMessage, 1024, {});
    req.end('{"enabled":true}');

    await expect(bodyPromise).resolves.toEqual({ enabled: true });
  });
});
