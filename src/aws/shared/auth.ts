import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { awsEnv } from './env.js';
import { type AuthenticatedUser, type UserRole, type UserStatus } from '../types.js';

const JWT_EXPIRY = '30d';
const PASSWORD_RESET_EXPIRY = '1h';

type JwtPayload = {
  email: string;
  fullName: string | null;
  organisationId: number;
  role: UserRole;
  status: UserStatus;
};

type PasswordResetJwtPayload = {
  email: string;
  purpose: 'password_reset';
};

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function signUserToken(user: AuthenticatedUser) {
  return jwt.sign(
    {
      email: user.email,
      fullName: user.fullName,
      organisationId: user.organisationId,
      role: user.role,
      status: user.status,
    } satisfies JwtPayload,
    awsEnv.jwtSecret,
    {
      expiresIn: JWT_EXPIRY,
      subject: String(user.id),
    },
  );
}

export function signPasswordResetToken(user: AuthenticatedUser) {
  return jwt.sign(
    {
      email: user.email,
      purpose: 'password_reset',
    } satisfies PasswordResetJwtPayload,
    awsEnv.jwtSecret,
    {
      expiresIn: PASSWORD_RESET_EXPIRY,
      subject: String(user.id),
    },
  );
}

export function verifyPasswordResetToken(token: string) {
  try {
    const decoded = jwt.verify(token, awsEnv.jwtSecret) as jwt.JwtPayload & Partial<PasswordResetJwtPayload>;
    const userId = Number(decoded.sub);
    const email = typeof decoded.email === 'string' ? decoded.email.trim().toLowerCase() : '';
    const purpose = decoded.purpose;

    if (!Number.isFinite(userId) || userId <= 0) {
      throw unauthorized('Invalid password reset token.');
    }

    if (!email || purpose !== 'password_reset') {
      throw unauthorized('Invalid password reset token.');
    }

    return {
      userId,
      email,
    };
  } catch {
    throw unauthorized('Invalid or expired password reset link.');
  }
}

export function requireAuthenticatedUser(event: APIGatewayProxyEventV2): AuthenticatedUser {
  const header = event.headers.authorization ?? event.headers.Authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw unauthorized('Missing bearer token.');
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw unauthorized('Missing bearer token.');
  }

  try {
    const decoded = jwt.verify(token, awsEnv.jwtSecret) as jwt.JwtPayload & Partial<JwtPayload>;
    const id = Number(decoded.sub);
    const organisationId = Number(decoded.organisationId);
    const role = decoded.role;
    const status = decoded.status;

    if (!Number.isFinite(id) || id <= 0) {
      throw unauthorized('Invalid token subject.');
    }

    if (!Number.isFinite(organisationId) || organisationId <= 0) {
      throw unauthorized('Invalid organisation scope.');
    }

    if (role !== 'Business_Admin' && role !== 'Standard_Employee') {
      throw unauthorized('Invalid role scope.');
    }

    if (status !== 'active' && status !== 'pending_invite') {
      throw unauthorized('Invalid account status.');
    }

    return {
      id,
      organisationId,
      email: typeof decoded.email === 'string' ? decoded.email : '',
      fullName: typeof decoded.fullName === 'string' ? decoded.fullName : null,
      role,
      status,
    };
  } catch {
    throw unauthorized('Invalid or expired token.');
  }
}

export function requireAdminUser(user: AuthenticatedUser) {
  if (user.role !== 'Business_Admin') {
    throw forbidden('Only admins can perform this action.');
  }
}

export function unauthorized(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 401;
  error.code = 'unauthorized';
  return error;
}

export function forbidden(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 403;
  error.code = 'forbidden';
  return error;
}
