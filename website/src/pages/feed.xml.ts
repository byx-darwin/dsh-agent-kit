import type { APIRoute } from 'astro'
import { renderFeed } from '../lib/feed'

export const GET: APIRoute = ({ site }) =>
  new Response(renderFeed(site!.href, import.meta.env.BASE_URL), {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  })
