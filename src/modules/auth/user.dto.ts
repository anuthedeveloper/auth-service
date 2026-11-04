export interface PublicUser {
  id: string;
  email: string;
  role: string;
  emailVerified: boolean;
  createdAt: Date;
}

interface UserRecord {
  id: string;
  email: string;
  role: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

/** Whitelist the fields that may leave the service. Never spread the DB record. */
export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
  };
}
