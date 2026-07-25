import axios from 'axios';

const api = axios.create({
  baseURL: process.env.VUE_APP_API_BASE_URL || '/api'
});

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('linquan_maintainer_token') || localStorage.getItem('linquan_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;
