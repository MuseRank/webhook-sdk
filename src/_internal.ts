/**
 * @internal
 * Shared body-reading and size-enforcement utilities used by framework adapters.
 * Not part of the public API.
 */

import {
  assertBodySizeLimit,
  verifyBearerToken,
  WebhookVerificationError,
} from "./index";

// ============================================================================
// PRE-BODY AUTHORIZATION
// ============================================================================

/**
 * Reject a request whose `Authorization` header does not carry the
 * configured bearer token, BEFORE its body is read.
 *
 * Adapters call this ahead of buffering so an unauthenticated client
 * cannot make the SDK hold up to `maxBodySizeBytes` in memory. The core
 * handler repeats the same check, so this only changes ordering: the
 * request is rejected with the same 401 either way.
 */
export function assertAuthorizedBeforeBody(
  headers: Record<string, string | undefined>,
  accessToken: string,
): void {
  if (!verifyBearerToken(headers["authorization"], accessToken)) {
    throw new WebhookVerificationError("Invalid or missing authorization", 401);
  }
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Minimal interface for a Node.js-style event emitter that supports the
 * `data`, `end`, and `error` events emitted by `http.IncomingMessage`.
 */
export interface NodeBodyStream {
  on(event: "data", fn: (chunk: Buffer) => void): void;
  on(event: "end", fn: () => void): void;
  on(event: "error", fn: (err: Error) => void): void;
  headers?: Record<string, string | string[] | undefined>;
}

// ============================================================================
// BODY SIZE ENFORCEMENT
// ============================================================================

export function enforceBodyStringLimit(
  body: string,
  maxBodySizeBytes: number,
): void {
  assertBodySizeLimit(body, maxBodySizeBytes);
}

export function enforceBodyObjectLimit(
  body: object,
  maxBodySizeBytes: number,
): void {
  assertBodySizeLimit(body, maxBodySizeBytes);
}

// ============================================================================
// BODY READERS
// ============================================================================

/**
 * Read a Web/Fetch API Request body stream, enforcing payload size limits.
 * Checks `content-length` eagerly, then enforces byte-by-byte during streaming.
 */
export async function readFetchBodyWithLimit(
  request: Request,
  maxBodySizeBytes: number,
): Promise<string> {
  const contentLength = request.headers.get("content-length");

  if (maxBodySizeBytes > 0 && contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);

    if (Number.isFinite(parsedLength) && parsedLength > maxBodySizeBytes) {
      throw new WebhookVerificationError(
        `Webhook payload too large (${parsedLength} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
        413,
      );
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalSize += value.byteLength;

    if (maxBodySizeBytes > 0 && totalSize > maxBodySizeBytes) {
      await reader.cancel();
      throw new WebhookVerificationError(
        `Webhook payload too large (${totalSize} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
        413,
      );
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalSize);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

/**
 * Read a Node.js request body stream (`http.IncomingMessage` subset),
 * enforcing payload size limits.  Marks the promise as settled immediately
 * on rejection so that late `data` events are silently ignored rather than
 * causing additional work or memory allocation.
 */
export function readNodeBodyWithLimit(
  req: NodeBodyStream,
  maxBodySizeBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const contentLengthHeader = req.headers?.["content-length"];
    const contentLength = Array.isArray(contentLengthHeader)
      ? contentLengthHeader[0]
      : contentLengthHeader;

    if (maxBodySizeBytes > 0 && contentLength) {
      const parsedLength = Number.parseInt(contentLength, 10);

      if (Number.isFinite(parsedLength) && parsedLength > maxBodySizeBytes) {
        reject(
          new WebhookVerificationError(
            `Webhook payload too large (${parsedLength} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
            413,
          ),
        );
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;

      totalSize += chunk.length;

      if (maxBodySizeBytes > 0 && totalSize > maxBodySizeBytes) {
        rejectOnce(
          new WebhookVerificationError(
            `Webhook payload too large (${totalSize} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
            413,
          ),
        );
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (err: Error) => rejectOnce(err));
  });
}
