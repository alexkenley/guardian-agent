import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body too large (limit: ${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const body = await readBody(req, maxBytes);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error('Invalid JSON');
  }
}

export async function readOptionalJsonBody<T>(
  req: IncomingMessage,
  maxBytes: number,
  emptyValue: T,
): Promise<T> {
  const body = await readBody(req, maxBytes);
  if (!body.trim()) {
    return emptyValue;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error('Invalid JSON');
  }
}
