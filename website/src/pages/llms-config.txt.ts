import type { APIRoute } from 'astro'
import { renderLlmsConfig } from '../lib/llms'

export const GET: APIRoute = () => new Response(renderLlmsConfig(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
