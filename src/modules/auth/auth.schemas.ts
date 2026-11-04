import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);

// Length over composition rules (NIST 800-63B). The upper bound prevents hashing abuse.
const newPassword = z.string().min(10, 'Password must be at least 10 characters').max(128);

const opaqueToken = z.string().min(1).max(512);

export const registerSchema = z.object({
  email,
  password: newPassword,
});

export const loginSchema = z.object({
  email,
  // No policy checks on login: only make sure something sensible was sent.
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: opaqueToken,
});

export const verifyEmailSchema = z.object({ token: opaqueToken });

export const emailOnlySchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: opaqueToken,
  password: newPassword,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
