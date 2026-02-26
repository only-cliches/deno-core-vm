export function isDateLike(v: unknown): v is Date {
  return Object.prototype.toString.call(v) === "[object Date]";
}

export function assertErrorLike(e: unknown): asserts e is { name?: unknown; message?: unknown; stack?: unknown } {
  if (!e || typeof e !== "object") throw new Error(`Expected error-like object, got ${typeof e}`);
  if (!("message" in e)) throw new Error("Expected error-like to have message");
}