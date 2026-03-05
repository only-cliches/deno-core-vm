export function isDateLike(v: unknown): v is Date {
  return Object.prototype.toString.call(v) === "[object Date]";
}
