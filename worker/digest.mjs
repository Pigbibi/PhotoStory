// Every content hash in the worker is the same SHA-256 hex string: session
// keys, image checksums and inventory digests must compare with each other.
export const digest = async bytes =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');

export const hex = bytes => bytes
  ? Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('')
  : null;
