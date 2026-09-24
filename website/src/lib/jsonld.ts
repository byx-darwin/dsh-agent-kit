import faq from '../data/faq.json'
import { POSTS } from '../data/blog'
import { RELEASE } from '../data/release'
import { SERVICES } from '../data/services'
import { SITE } from './site'

const author = { '@type': 'Person', name: SITE.author.name, url: SITE.author.url }

export function softwareJsonLd(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE.name,
    description: SITE.positioning,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows',
    softwareVersion: RELEASE.version,
    license: 'https://opensource.org/licenses/MIT',
    url: SITE.url,
    sameAs: [SITE.repo, ...(RELEASE.published ? [SITE.npmUrl] : [])],
    author,
    featureList: SERVICES.map((s) => `${s.id}：${s.summary}`),
  }
}

export function faqJsonLd(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  }
}

export function blogPostingJsonLd(slug: string): object {
  const post = POSTS.find((p) => p.slug === slug)
  if (!post) throw new Error(`unknown post ${slug}`)
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    inLanguage: 'zh-CN',
    author,
    url: `${SITE.url}/blog/${post.slug}/`,
  }
}
