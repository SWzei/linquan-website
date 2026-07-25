import { defineStore } from 'pinia';
import api from '@/services/api';

function readStoredUser() {
  const raw = sessionStorage.getItem('linquan_maintainer_user') || localStorage.getItem('linquan_user');
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: sessionStorage.getItem('linquan_maintainer_token') || localStorage.getItem('linquan_token') || '',
    user: readStoredUser()
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
    isMember: (state) => state.user?.accountType === 'member',
    isAdmin: (state) => state.user?.accountType === 'member' && Boolean(state.user?.isAdmin),
    isMaintainer: (state) => state.user?.accountType === 'maintainer'
  },
  actions: {
    setAuth({ token, user }) {
      this.token = token;
      this.user = user;
      if (user?.accountType === 'maintainer') {
        localStorage.removeItem('linquan_token'); localStorage.removeItem('linquan_user');
        sessionStorage.setItem('linquan_maintainer_token', token);
        sessionStorage.setItem('linquan_maintainer_user', JSON.stringify(user));
      } else {
        sessionStorage.removeItem('linquan_maintainer_token'); sessionStorage.removeItem('linquan_maintainer_user');
        localStorage.setItem('linquan_token', token);
        localStorage.setItem('linquan_user', JSON.stringify(user));
      }
    },
    logout() {
      this.token = '';
      this.user = null;
      localStorage.removeItem('linquan_token');
      localStorage.removeItem('linquan_user');
      sessionStorage.removeItem('linquan_maintainer_token');
      sessionStorage.removeItem('linquan_maintainer_user');
    },
    async login({ credential, password }) {
      const { data } = await api.post('/auth/login', { credential, password });
      this.setAuth(data);
      return data;
    },
    async register({ studentNumber, email, password, displayName }) {
      const { data } = await api.post('/auth/register', {
        studentNumber,
        email,
        password,
        displayName
      });
      this.setAuth(data);
      return data;
    },
    async changePassword({ currentPassword, newPassword }) {
      const { data } = await api.post('/auth/change-password', { currentPassword, newPassword });
      this.logout();
      return data;
    },
    async acknowledgeProfileReminder() {
      const { data } = await api.post('/auth/profile-reminder/acknowledge');
      if (this.user?.accountType === 'member') {
        this.user = { ...this.user, profileReminderPending: false };
        localStorage.setItem('linquan_user', JSON.stringify(this.user));
      }
      return data;
    },
    async maintainerLogin({ credential, password }) {
      const { data } = await api.post('/maintainer/auth/login', { credential, password });
      this.setAuth(data);
      return data;
    },
    async refreshMemberSession() {
      if (!localStorage.getItem('linquan_token')) return null;
      const { data } = await api.get('/auth/me');
      this.user = data.user;
      localStorage.setItem('linquan_user', JSON.stringify(data.user));
      return data.user;
    }
  }
});
