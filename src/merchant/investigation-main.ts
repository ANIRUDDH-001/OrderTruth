// Synthetic demo host. No Store, credentials, provider or repair service is loaded.
import Fastify from 'fastify';
import { parseArgs } from 'node:util';
import { mountInvestigation } from './investigation-static.ts';
const {values}=parseArgs({options:{port:{type:'string',default:'3004'}}});
const port=Number(values.port);
if(!Number.isInteger(port)||port<1024||port>65535) throw Error('Invalid local port');
const app=Fastify({logger:false});
app.addHook('onRequest',async(req,reply)=>{if(req.method!=='GET'&&req.method!=='HEAD')return reply.code(405).header('allow','GET').send({error:'method_not_allowed'});});
await mountInvestigation(app);
const stop=async()=>{await app.close();process.exit(0);};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
await app.listen({host:'127.0.0.1',port});
console.log(`Local investigation: http://127.0.0.1:${port}/investigation/`);
