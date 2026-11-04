import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/errors';
import { getRequestContext } from '../../utils/requestContext';
import type { ChangeRoleInput, ListUsersQuery } from './admin.schemas';
import * as adminService from './admin.service';

export const listUsers = asyncHandler(async (req, res) => {
  const page = await adminService.listUsers(req.query as unknown as ListUsersQuery);
  res.status(200).json(page);
});

export const changeRole = asyncHandler(async (req, res) => {
  if (!req.auth) throw AppError.unauthorized();

  const { role } = req.body as ChangeRoleInput;
  const user = await adminService.changeRole(
    req.auth.userId,
    req.params.id as string,
    role,
    getRequestContext(req),
  );
  res.status(200).json({ user });
});
