import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ORG_ID } from './repo.ts';

export const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const INCIDENT = /^inc_[0-9a-f-]{36}$/;
const PAGES = ['incidents', 'checkouts', 'recovery'];

/** Operations console shell. Dedicated build only; deep links are validated before the SPA shell is returned. */
export async function mountConsole(app: FastifyInstance, root = resolve('dist/console')) {
  if (!existsSync(join(root, 'index.html'))) throw Error('Console build missing; run pnpm build first.');
  const html = () => readFileSync(join(root, 'index.html'), 'utf8');
  app.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/console') && !req.url.startsWith('/investigation') && req.url !== '/') return;
    reply.header('content-security-policy', CONSOLE_CSP);
    reply.header('x-content-type-options', 'nosniff'); reply.header('cache-control', 'no-store'); reply.header('referrer-policy', 'no-referrer');
  });
  const shell = async (_req: unknown, reply: import('fastify').FastifyReply) => reply.type('text/html; charset=utf-8').send(html());
  // Unknown console paths get the shell with a real 404 status, so the app can render its own not-found page.
  const missing = async (_req: unknown, reply: import('fastify').FastifyReply) => reply.status(404).type('text/html; charset=utf-8').send(html());
  app.get('/', async (_req, reply) => reply.redirect('/console/'));
  app.get('/console', async (_req, reply) => reply.redirect('/console/'));
  app.get('/console/', shell);
  app.get<{ Params: { page: string } }>('/console/:page', async (req, reply) => PAGES.includes(req.params.page) ? shell(req, reply) : missing(req, reply));
  app.get<{ Params: { id: string } }>('/console/incidents/:id', async (req, reply) => INCIDENT.test(req.params.id) ? shell(req, reply) : missing(req, reply));
  app.get('/console/*', missing);
  // The retired /investigation screen now lives in the console's Engineering lens. Old links keep working.
  const legacyList = async (_req: unknown, reply: import('fastify').FastifyReply) => reply.redirect('/console/incidents');
  // An org in the old link is carried into the console. A malformed or repeated org is rejected, never replaced by a default.
  const legacyIncident = async (req: import('fastify').FastifyRequest<{ Params: { id: string } }>, reply: import('fastify').FastifyReply) => {
    if (!INCIDENT.test(req.params.id)) return missing(req, reply);
    const orgs = new URLSearchParams(req.url.split('?')[1] ?? '').getAll('org');
    if (orgs.length > 1 || (orgs.length === 1 && !ORG_ID.test(orgs[0]!))) return reply.status(400).type('text/html; charset=utf-8').send(html());
    return reply.redirect(`/console/incidents/${req.params.id}?lens=eng${orgs.length ? `&org=${orgs[0]}` : ''}`);
  };
  app.get('/investigation', legacyList);
  app.get('/investigation/', legacyList);
  app.get<{ Params: { id: string } }>('/investigation/:id', legacyIncident);
  app.get<{ Params: { id: string } }>('/investigation/:id/', legacyIncident);
  app.get('/investigation/*', missing);
  await app.register(fastifyStatic, { root: join(root, 'assets'), prefix: '/console/assets/', decorateReply: false, index: false, dotfiles: 'deny' });
}
