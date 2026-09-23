export const passwordRequirementsMessage = 'Use at least 8 characters, one capital letter, and one special character.';

export function meetsPasswordRequirements(password: string) {
  return password.length >= 8 && /[A-Z]/.test(password) && /[\p{P}\p{S}]/u.test(password);
}
