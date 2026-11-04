import type { Request } from 'express';

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/** Client details stored with audit events and sessions. */
export function getRequestContext(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.get('user-agent') };
}
