export function requiresForcedPasswordChange(user) {
  return user?.accountType === 'member' && Boolean(user.mustChangePassword);
}

export function shouldShowProfileReminder(user) {
  return user?.accountType === 'member'
    && Boolean(user.profileReminderPending)
    && !requiresForcedPasswordChange(user);
}

export function shouldRedirectToPasswordChange({
  memberToken,
  user,
  allowsRequiredPasswordChange = false
}) {
  return Boolean(memberToken)
    && requiresForcedPasswordChange(user)
    && !allowsRequiredPasswordChange;
}
