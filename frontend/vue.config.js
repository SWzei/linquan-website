module.exports = {
  productionSourceMap: false,
  devServer: {
    host: '0.0.0.0',
    allowedHosts: 'all',
    proxy: {
      '/api': {
        target: process.env.VUE_APP_DEV_API_TARGET || 'http://localhost:4000',
        changeOrigin: true
      },
      '/uploads': {
        target: process.env.VUE_APP_DEV_API_TARGET || 'http://localhost:4000',
        changeOrigin: true
      },
      '/ws': {
        target: process.env.VUE_APP_DEV_API_TARGET || 'http://localhost:4000',
        ws: true
      }
    }
  }
};
