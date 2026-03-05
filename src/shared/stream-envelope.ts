export const STREAM_BRIDGE_TAG = "__denojs_worker_stream_v1";
export const STREAM_TYPED_CHUNK_PREFIX = "__denojs_worker_stream_chunk_v1:";
export const STREAM_TYPED_CONTROL_PREFIX = "__denojs_worker_stream_control_v1:";
export const STREAM_CHUNK_MAGIC = [0x44, 0x44, 0x53, 0x54, 0x52, 0x4d, 0x31, 0x00];
export const STREAM_FRAME_TYPE_TO_CODE = {
  open: 1,
  chunk: 2,
  close: 3,
  error: 4,
  cancel: 5,
  discard: 6,
  credit: 7,
};
export const STREAM_FRAME_CODE_TO_TYPE = {
  1: "open",
  2: "chunk",
  3: "close",
  4: "error",
  5: "cancel",
  6: "discard",
  7: "credit",
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function asUint8View(payload: any): Uint8Array | null {
  if (typeof Uint8Array === "undefined") return null;
  if (payload instanceof Uint8Array) return payload;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof ArrayBuffer !== "undefined" && payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  if (
    payload &&
    typeof payload === "object" &&
    typeof ArrayBuffer !== "undefined" &&
    typeof ArrayBuffer.isView === "function" &&
    ArrayBuffer.isView(payload)
  ) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
}

export function encodeStreamFrameEnvelope(frame: any): Uint8Array {
  const typeCode = STREAM_FRAME_TYPE_TO_CODE[String(frame && frame.t || "")];
  if (!typeCode) throw new Error(`Unknown stream frame type: ${String(frame && frame.t)}`);

  const idBytes = textEncoder.encode(String(frame && frame.id || ""));
  if (!idBytes || idBytes.length === 0 || idBytes.length > 0xffff) {
    throw new Error(`Invalid stream id length: ${idBytes ? idBytes.length : 0}`);
  }

  let aux = "";
  if (frame.t === "open") aux = frame.key == null ? "" : String(frame.key);
  else if (frame.t === "error") aux = frame.error == null ? "" : String(frame.error);
  else if (frame.t === "cancel") aux = frame.reason == null ? "" : String(frame.reason);
  else if (frame.t === "credit") aux = String(Math.max(0, Math.trunc(frame.credit || 0)));
  const auxBytes = textEncoder.encode(aux);
  if (auxBytes.length > 0xffff) throw new Error(`Invalid stream aux length: ${auxBytes.length}`);

  const chunk = frame.t === "chunk" && frame.chunk instanceof Uint8Array ? frame.chunk : new Uint8Array(0);
  const out = new Uint8Array(
    STREAM_CHUNK_MAGIC.length + 1 + 2 + 2 + idBytes.length + auxBytes.length + chunk.byteLength
  );
  out.set(STREAM_CHUNK_MAGIC, 0);
  let off = STREAM_CHUNK_MAGIC.length;
  out[off] = typeCode & 0xff;
  off += 1;
  out[off] = (idBytes.length >>> 8) & 0xff;
  out[off + 1] = idBytes.length & 0xff;
  off += 2;
  out[off] = (auxBytes.length >>> 8) & 0xff;
  out[off + 1] = auxBytes.length & 0xff;
  off += 2;
  out.set(idBytes, off);
  off += idBytes.length;
  out.set(auxBytes, off);
  off += auxBytes.length;
  out.set(chunk, off);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  }
  return out;
}

export function decodeStreamFrameEnvelope(payload: any): any {
  const u8 = asUint8View(payload);
  if (!u8) return null;
  const minLen = STREAM_CHUNK_MAGIC.length + 1 + 2 + 2 + 1;
  if (u8.byteLength < minLen) return null;
  for (let i = 0; i < STREAM_CHUNK_MAGIC.length; i += 1) {
    if (u8[i] !== STREAM_CHUNK_MAGIC[i]) return null;
  }

  let off = STREAM_CHUNK_MAGIC.length;
  const typeCode = u8[off] >>> 0;
  off += 1;
  const t = STREAM_FRAME_CODE_TO_TYPE[typeCode];
  if (!t) return null;
  const idLen = ((u8[off] << 8) | u8[off + 1]) >>> 0;
  off += 2;
  const auxLen = ((u8[off] << 8) | u8[off + 1]) >>> 0;
  off += 2;
  if (idLen === 0 || off + idLen + auxLen > u8.byteLength) return null;

  const id = textDecoder.decode(u8.subarray(off, off + idLen));
  if (!id) return null;
  off += idLen;
  const aux = auxLen > 0 ? textDecoder.decode(u8.subarray(off, off + auxLen)) : "";
  off += auxLen;

  const out: any = {
    [STREAM_BRIDGE_TAG]: true,
    t,
    id,
  };
  if (t === "open" && aux) out.key = aux;
  else if (t === "error" && aux) out.error = aux;
  else if (t === "cancel" && aux) out.reason = aux;
  else if (t === "credit") out.credit = Number(aux || "0");
  else if (t === "chunk") out.chunk = u8.subarray(off);
  return out;
}

export function decodeTypedStreamChunkMessage(payload: any, hydrateFn?: (value: any) => any): any {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const type = payload.type;
  if (typeof type !== "string" || !type.startsWith(STREAM_TYPED_CHUNK_PREFIX)) return null;
  const id = type.slice(STREAM_TYPED_CHUNK_PREFIX.length);
  if (!id) return null;
  let chunk = asUint8View(payload.payload);
  if (!chunk && payload.payload && typeof payload.payload === "object" && typeof hydrateFn === "function") {
    try {
      chunk = asUint8View(hydrateFn(payload.payload));
    } catch {
      // ignore
    }
  }
  if (!chunk) return null;
  return {
    [STREAM_BRIDGE_TAG]: true,
    t: "chunk",
    id,
    chunk,
  };
}

export function decodeTypedStreamControlMessage(payload: any): any {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const type = payload.type;
  if (typeof type !== "string" || !type.startsWith(STREAM_TYPED_CONTROL_PREFIX)) return null;
  const rest = type.slice(STREAM_TYPED_CONTROL_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const kind = rest.slice(0, sep);
  const id = rest.slice(sep + 1);
  if (!id) return null;

  const out: any = {
    [STREAM_BRIDGE_TAG]: true,
    t: kind,
    id,
  };
  const auxRaw = payload && typeof payload.payload === "string" ? payload.payload : "";
  if (kind === "open") out.key = auxRaw;
  else if (kind === "error") out.error = auxRaw;
  else if (kind === "cancel") out.reason = auxRaw;
  else if (kind === "credit") out.credit = Number(auxRaw || "0");
  return out;
}
