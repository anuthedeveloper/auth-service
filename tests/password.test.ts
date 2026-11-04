import { hashPassword, verifyAgainstDummy, verifyPassword } from '../src/utils/password';

describe('password utils', () => {
  it('hashes with argon2id and never returns the plaintext', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('produces a different hash each time (random salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-1'), hashPassword('same-password-1')]);

    expect(a).not.toBe(b);
  });

  it('verifies correct and incorrect passwords', async () => {
    const hash = await hashPassword('correct horse battery');

    await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password!!')).resolves.toBe(false);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    await expect(verifyPassword('not-a-real-hash', 'anything')).resolves.toBe(false);
  });

  it('runs the dummy verification without throwing', async () => {
    await expect(verifyAgainstDummy('whatever')).resolves.toBeUndefined();
  });
});
