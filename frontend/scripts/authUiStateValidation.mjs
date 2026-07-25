import assert from 'node:assert/strict';
import {
  requiresForcedPasswordChange,
  shouldRedirectToPasswordChange,
  shouldShowProfileReminder
} from '../src/utils/authUiState.mjs';

const bothPending = {
  accountType: 'member',
  mustChangePassword: true,
  profileReminderPending: true
};
assert.equal(requiresForcedPasswordChange(bothPending), true);
assert.equal(shouldShowProfileReminder(bothPending), false);
assert.equal(
  shouldRedirectToPasswordChange({
    memberToken: 'member-token',
    user: bothPending,
    allowsRequiredPasswordChange: false
  }),
  true
);
assert.equal(
  shouldRedirectToPasswordChange({
    memberToken: 'member-token',
    user: bothPending,
    allowsRequiredPasswordChange: true
  }),
  false
);

const afterPasswordChange = {
  ...bothPending,
  mustChangePassword: false
};
assert.equal(requiresForcedPasswordChange(afterPasswordChange), false);
assert.equal(shouldShowProfileReminder(afterPasswordChange), true);
assert.equal(
  shouldRedirectToPasswordChange({
    memberToken: 'member-token',
    user: afterPasswordChange
  }),
  false
);

assert.equal(
  shouldShowProfileReminder({
    ...afterPasswordChange,
    profileReminderPending: false
  }),
  false
);
assert.equal(
  shouldShowProfileReminder({
    accountType: 'member',
    mustChangePassword: true,
    profileReminderPending: false
  }),
  false
);
assert.equal(
  shouldShowProfileReminder({
    accountType: 'member',
    mustChangePassword: false,
    profileReminderPending: true
  }),
  true
);
assert.equal(
  shouldShowProfileReminder({
    accountType: 'maintainer',
    mustChangePassword: false,
    profileReminderPending: true
  }),
  false
);
assert.equal(shouldShowProfileReminder(null), false);
assert.equal(
  shouldRedirectToPasswordChange({
    memberToken: '',
    user: bothPending
  }),
  false
);

console.log('Auth UI state validation passed.');
