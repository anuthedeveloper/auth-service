import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validate } from '../../middleware/validate';
import { changeRole, listUsers } from './admin.controller';
import { changeRoleSchema, listUsersQuerySchema, userIdParamSchema } from './admin.schemas';

export const adminRouter = Router();

// Everything under /admin requires a valid token AND the ADMIN role.
adminRouter.use(authenticate, requireRole('ADMIN'));

adminRouter.get('/users', validate(listUsersQuerySchema, 'query'), listUsers);
adminRouter.patch(
  '/users/:id/role',
  validate(userIdParamSchema, 'params'),
  validate(changeRoleSchema),
  changeRole,
);
