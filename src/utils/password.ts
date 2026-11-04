import argon2 from 'argon2';

/** Hash with argon2id (library defaults: 64 MiB memory, 3 passes). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed hash: treat as a failed verification rather than a server error.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Performs a verification against a throwaway hash so that logins for unknown emails
 * take about as long as logins for real accounts (mitigates user enumeration by timing).
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-used-for-timing-only');
  await verifyPassword(await dummyHash, password);
}
