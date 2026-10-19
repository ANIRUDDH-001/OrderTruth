import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/** Dedicated build only. Never mount a project directory, database directory or checkout build. */
export async function mountInvestigation(app: FastifyInstance, root = resolve('dist/investigation')) {
  if(!existsSync(join(root,'index.html'))) throw Error('Investigation build missing; run pnpm build first.');
  const html=()=>readFileSync(join(root,'index.html'),'utf8');
  app.addHook('onSend',async (_req,reply)=>{
    reply.header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    reply.header('x-content-type-options','nosniff');reply.header('cache-control','no-store');reply.header('referrer-policy','no-referrer');
  });
  app.get('/investigation',async (_req,reply)=>reply.redirect('/investigation/'));
  app.get('/investigation/',async (_req,reply)=>reply.type('text/html; charset=utf-8').send(html()));
  app.get<{Params:{id:string}}>('/investigation/:id/',async (req,reply)=>{
    if(!/^inc_[0-9a-f-]{36}$/.test(req.params.id)) return reply.status(404).send({error:'not_found'});
    return reply.type('text/html; charset=utf-8').send(html());
  });
  await app.register(fastifyStatic,{root:join(root,'assets'),prefix:'/investigation/assets/',decorateReply:false,index:false,dotfiles:'deny'});
}
