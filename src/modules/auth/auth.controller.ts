import type { Response } from 'express';
import { AppError } from '../../utils/errors';
import { asyncHandler } from '../../utils/asyncHandler';
import { runInBackground } from '../../utils/background';
import { getRequestContext } from '../../utils/requestContext';
import * as accountService from './account.service';
import type {
  EmailOnlyInput,
  LoginInput,
  RefreshInput,
  RegisterInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from './auth.schemas';
import * as authService from './auth.service';

/** Responses that carry tokens must never be cached (RFC 6749 section 5.1). */
function sendAuthResult(res: Response, status: number, result: authService.AuthResult): void {
  res.set('Cache-Control', 'no-store');
  res.status(status).json({ user: result.user, ...result.tokens });
}

export const register = asyncHandler(async (req, res) => {
  const user = await authService.register(req.body as RegisterInput, getRequestContext(req));
  res.status(201).json({ user });
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body as LoginInput, getRequestContext(req));
  sendAuthResult(res, 200, result);
});

export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body as RefreshInput;
  const result = await authService.refresh(refreshToken, getRequestContext(req));
  sendAuthResult(res, 200, result);
});

export const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body as RefreshInput;
  await authService.logout(refreshToken, getRequestContext(req));
  res.status(204).end();
});

export const logoutAll = asyncHandler(async (req, res) => {
  if (!req.auth) throw AppError.unauthorized();
  const sessionsRevoked = await authService.logoutAll(req.auth.userId, getRequestContext(req));
  res.status(200).json({ sessionsRevoked });
});

export const me = asyncHandler(async (req, res) => {
  if (!req.auth) throw AppError.unauthorized();
  const user = await authService.getUserById(req.auth.userId);
  res.status(200).json({ user });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body as VerifyEmailInput;
  const user = await accountService.verifyEmail(token, getRequestContext(req));
  res.status(200).json({ user });
});

// The two endpoints below answer 202 with the same body whether or not the account exists,
// and do their work in the background so response time doesn't reveal it either.

export const resendVerification = asyncHandler(async (req, res) => {
  const { email } = req.body as EmailOnlyInput;
  runInBackground('resend-verification', () => accountService.resendVerification(email));
  res.status(202).json({
    message: 'If an unverified account exists for this email, a new verification email has been sent.',
  });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body as EmailOnlyInput;
  const ctx = getRequestContext(req);
  runInBackground('forgot-password', () => accountService.requestPasswordReset(email, ctx));
  res.status(202).json({
    message: 'If an account exists for this email, a password reset link has been sent.',
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body as ResetPasswordInput;
  await accountService.resetPassword(token, password, getRequestContext(req));
  res.status(200).json({ message: 'Password updated. Please sign in again.' });
});
