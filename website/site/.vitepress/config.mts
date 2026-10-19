import { defineConfig } from 'vitepress'

// WEBSITE_BASE: deployment sub-path (e.g. /rovai-ai/); WEBSITE_ORIGIN: public site URL.
const base = `${(process.env.WEBSITE_BASE || '/').replace(/\/*$/, '')}/`

export default defineConfig({
  title: 'Rovai AI',
  base,
  cleanUrls: false,
  lang: 'en-US',
  locales: {
    root: { label: 'English', lang: 'en-US' },
    zh: { label: '简体中文', lang: 'zh-CN' }
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}assets/mark.svg` }],
    ['link', { rel: 'stylesheet', href: `${base}assets/site.css` }],
    ['meta', { name: 'theme-color', content: '#fbfbfa' }]
  ],
  sitemap: { hostname: process.env.WEBSITE_ORIGIN || 'https://rovai.dev' },
  transformHtml(html, id) {
    const path = id.replaceAll('\\', '/')
    const page = path.includes('/docs/') ? 'docs' : path.includes('/download/') ? 'download' : 'home'
    const lang = path.includes('/zh/') ? 'zh' : 'en'
    return html.replace('<body', `<body data-page="${page}" data-lang="${lang}"`)
  }
})
