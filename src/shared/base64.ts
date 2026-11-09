// workerd has Uint8Array's own base64 methods, which TypeScript's libraries don't declare yet.

export const toBase64 = (bytes: Uint8Array): string => (bytes as Uint8Array & { toBase64(): string }).toBase64();

export const fromBase64 = (base64: string): Uint8Array<ArrayBuffer> =>
  (Uint8Array as unknown as { fromBase64(base64: string): Uint8Array<ArrayBuffer> }).fromBase64(base64);
