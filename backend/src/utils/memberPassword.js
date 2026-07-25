import crypto from 'crypto';
import { z } from 'zod';

export const MEMBER_PASSWORD_MIN_LENGTH = 8;
export const MEMBER_PASSWORD_MAX_LENGTH = 128;
export const MEMBER_PASSWORD_REQUIREMENT = 'Password must be 8-128 characters and contain at least one letter and one number';

export const memberPasswordSchema = z
  .string()
  .min(MEMBER_PASSWORD_MIN_LENGTH, MEMBER_PASSWORD_REQUIREMENT)
  .max(MEMBER_PASSWORD_MAX_LENGTH, MEMBER_PASSWORD_REQUIREMENT)
  .regex(/[A-Za-z]/, MEMBER_PASSWORD_REQUIREMENT)
  .regex(/\d/, MEMBER_PASSWORD_REQUIREMENT);

export function assertStrongMemberPassword(password) {
  const result = memberPasswordSchema.safeParse(password);
  if (!result.success) {
    throw new Error(MEMBER_PASSWORD_REQUIREMENT);
  }
  return result.data;
}

export function generateStrongMemberPassword(length = 14) {
  const safeLength = Math.max(MEMBER_PASSWORD_MIN_LENGTH, Math.min(MEMBER_PASSWORD_MAX_LENGTH, length));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const required = ['A', 'a', '2'];
  const random = Array.from(
    crypto.randomBytes(safeLength - required.length),
    (byte) => alphabet[byte % alphabet.length]
  );
  const characters = [...required, ...random];
  const shuffleBytes = crypto.randomBytes(characters.length);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = shuffleBytes[index] % (index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join('');
}
