import argon2 from 'argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/** Argon2id with the library's recommended work factors, or cheaper ones for tests. */
export function createPasswordHasher(options: { memoryCost?: number; timeCost?: number } = {}): PasswordHasher {
  const params = { type: argon2.argon2id as 2, ...options };
  return {
    hash: (password) => argon2.hash(password, params),
    async verify(hash, password) {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    }
  };
}
