process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-secret-only-for-jest-0123456789abcdef';
// Most suites sign in and register dozens of times from one IP; the rate limit tests turn this on.
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.RATE_LIMIT_STORE = 'memory';
