import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from '@/views/DashboardView.vue';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
import ChangePasswordView from '@/views/ChangePasswordView.vue';
import ScheduleView from '@/views/ScheduleView.vue';
import ClassMatchingView from '@/views/ClassMatchingView.vue';
import ConcertsView from '@/views/ConcertsView.vue';
import ProfileView from '@/views/ProfileView.vue';
import MemberDirectoryView from '@/views/MemberDirectoryView.vue';
import MemberDetailView from '@/views/MemberDetailView.vue';
import GalleryView from '@/views/GalleryView.vue';
import ContributorsView from '@/views/ContributorsView.vue';
import MaintainerLoginView from '@/views/MaintainerLoginView.vue';
import MaintainerView from '@/views/MaintainerView.vue';
import MaintainerContributorsView from '@/views/MaintainerContributorsView.vue';
import AdminLayoutView from '@/views/AdminLayoutView.vue';
import AdminPublishingView from '@/views/AdminPublishingView.vue';
import AdminSchedulingView from '@/views/AdminSchedulingView.vue';
import AdminClassMatchingView from '@/views/AdminClassMatchingView.vue';
import AdminConcertsView from '@/views/AdminConcertsView.vue';
import AdminGalleryView from '@/views/AdminGalleryView.vue';
import AdminMembersView from '@/views/AdminMembersView.vue';
import ArchiveCenterView from '@/views/ArchiveCenterView.vue';
import NotFoundView from '@/views/NotFoundView.vue';
import api from '@/services/api';
import { useAuthStore } from '@/stores/auth';
import { shouldRedirectToPasswordChange } from '@/utils/authUiState.mjs';

const routes = [
  {
    path: '/',
    name: 'dashboard',
    component: DashboardView
  },
  {
    path: '/login',
    name: 'login',
    component: LoginView
  },
  {
    path: '/register',
    name: 'register',
    component: RegisterView
  },
  {
    path: '/change-password',
    name: 'changePassword',
    component: ChangePasswordView,
    meta: { requiresMember: true, allowsRequiredPasswordChange: true }
  },
  {
    path: '/schedule',
    name: 'schedule',
    component: ScheduleView,
    meta: { requiresAuth: true }
  },
  {
    path: '/class-matching',
    name: 'classMatching',
    component: ClassMatchingView,
    meta: { requiresAuth: true }
  },
  {
    path: '/concerts',
    name: 'concerts',
    component: ConcertsView,
    meta: { requiresMember: true }
  },
  {
    path: '/profile',
    name: 'profile',
    component: ProfileView,
    meta: { requiresMember: true }
  },
  {
    path: '/members',
    name: 'members',
    component: MemberDirectoryView
  },
  {
    path: '/members/:publicId',
    name: 'memberDetail',
    component: MemberDetailView
  },
  {
    path: '/gallery',
    name: 'gallery',
    component: GalleryView
  },
  {
    path: '/contributors',
    name: 'contributors',
    component: ContributorsView
  },
  {
    path: '/maintainer/login',
    name: 'maintainerLogin',
    component: MaintainerLoginView
  },
  {
    path: '/maintainer',
    name: 'maintainer',
    component: MaintainerView,
    meta: { requiresMaintainer: true }
  },
  {
    path: '/maintainer/contributors',
    name: 'maintainerContributors',
    component: MaintainerContributorsView,
    meta: { requiresMaintainer: true }
  },
  {
    path: '/maintainer/archive',
    name: 'maintainerArchive',
    component: ArchiveCenterView,
    meta: { requiresMaintainer: true }
  },
  {
    path: '/admin',
    component: AdminLayoutView,
    meta: { requiresAdmin: true },
    children: [
      {
        path: '',
        redirect: { name: 'adminPublishing' }
      },
      {
        path: 'publishing',
        name: 'adminPublishing',
        component: AdminPublishingView
      },
      {
        path: 'scheduling',
        name: 'adminScheduling',
        component: AdminSchedulingView
      },
      {
        path: 'class-matching',
        name: 'adminClassMatching',
        component: AdminClassMatchingView
      },
      {
        path: 'concerts',
        name: 'adminConcerts',
        component: AdminConcertsView
      },
      {
        path: 'gallery',
        name: 'adminGallery',
        component: AdminGalleryView
      },
      {
        path: 'members',
        name: 'adminMembers',
        component: AdminMembersView
      },
      {
        path: 'archive',
        name: 'adminArchive',
        component: ArchiveCenterView
      }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'notFound',
    component: NotFoundView
  }
];

const router = createRouter({
  history: createWebHistory(process.env.BASE_URL),
  routes
});

router.beforeEach(async (to, from, next) => {
  const auth = useAuthStore();
  const memberToken = localStorage.getItem('linquan_token');
  const maintainerToken = sessionStorage.getItem('linquan_maintainer_token');
  let user = null;
  try {
    user = JSON.parse(sessionStorage.getItem('linquan_maintainer_user') || localStorage.getItem('linquan_user') || 'null');
  } catch (err) {
    user = null;
  }

  if (memberToken && (to.meta.requiresAuth || to.meta.requiresMember || to.meta.requiresAdmin)) {
    try {
      const { data } = await api.get('/auth/me');
      user = data.user;
      localStorage.setItem('linquan_user', JSON.stringify(user));
      auth.user = user;
    } catch (err) {
      if (err?.response?.status === 401) {
        localStorage.removeItem('linquan_token');
        localStorage.removeItem('linquan_user');
        user = null;
        auth.token = '';
        auth.user = null;
      }
    }
  }

  if (maintainerToken && to.meta.requiresMaintainer) {
    try {
      const { data } = await api.get('/maintainer/me');
      user = data.user || data;
      sessionStorage.setItem('linquan_maintainer_user', JSON.stringify(user));
      auth.user = user;
    } catch (err) {
      if (err?.response?.status === 401 || err?.response?.status === 403) {
        sessionStorage.removeItem('linquan_maintainer_token');
        sessionStorage.removeItem('linquan_maintainer_user');
        user = null;
        auth.token = '';
        auth.user = null;
      }
    }
  }

  if ((to.meta.requiresAuth || to.meta.requiresMember) && (!memberToken || user?.accountType !== 'member')) {
    return next({ name: 'login', query: { redirect: to.fullPath } });
  }
  if (shouldRedirectToPasswordChange({
    memberToken,
    user,
    allowsRequiredPasswordChange: Boolean(to.meta.allowsRequiredPasswordChange)
  })) {
    return next({ name: 'changePassword' });
  }
  if (to.name === 'changePassword' && user?.accountType === 'member' && !user?.mustChangePassword) {
    return next({ name: 'dashboard' });
  }
  if (to.meta.requiresAdmin && (!memberToken || user?.accountType !== 'member' || !user?.isAdmin)) {
    return next({ name: 'dashboard' });
  }
  if (to.meta.requiresMaintainer && (!maintainerToken || user?.accountType !== 'maintainer')) return next({ name: 'maintainerLogin' });
  if (user?.accountType === 'maintainer' && !to.meta.requiresMaintainer && to.name !== 'maintainerLogin') return next({ name: 'maintainer' });
  return next();
});

export default router;
