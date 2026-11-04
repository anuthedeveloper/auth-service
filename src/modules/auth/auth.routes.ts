import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import {
  forgotPasswordAddressLimiter,
  forgotPasswordLimiter,
  loginLimiter,
  refreshLimiter,
  registerLimiter,
  resendVerificationAddressLimiter,
  resendVerificationLimiter,
  resetPasswordLimiter,
  verifyEmailLimiter,
} from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import {
  forgotPassword,
  login,
  logout,
  logoutAll,
  me,
  refresh,
  register,
  resendVerification,
  resetPassword,
  verifyEmail,
} from './auth.controller';
import {
  emailOnlySchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schemas';

export const authRouter = Router();

// Limiters run before validation so junk requests are counted too. The per-address limiters
// run after it, because they need the normalized email from the body.

authRouter.post('/register', registerLimiter, validate(registerSchema), register);
authRouter.post('/login', loginLimiter, validate(loginSchema), login);
authRouter.post('/refresh', refreshLimiter, validate(refreshSchema), refresh);
authRouter.post('/logout', validate(refreshSchema), logout);
authRouter.post('/logout-all', authenticate, logoutAll);
authRouter.get('/me', authenticate, me);

authRouter.post('/verify-email', verifyEmailLimiter, validate(verifyEmailSchema), verifyEmail);
authRouter.post(
  '/resend-verification',
  resendVerificationLimiter,
  validate(emailOnlySchema),
  resendVerificationAddressLimiter,
  resendVerification,
);
authRouter.post(
  '/forgot-password',
  forgotPasswordLimiter,
  validate(emailOnlySchema),
  forgotPasswordAddressLimiter,
  forgotPassword,
);
authRouter.post('/reset-password', resetPasswordLimiter, validate(resetPasswordSchema), resetPassword);
