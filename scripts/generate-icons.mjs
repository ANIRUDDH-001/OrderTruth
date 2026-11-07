// Local asset authoring only; generated icons are committed, no runtime dependency.
// npm install --prefix .work/icon-tools --no-audit --no-fund --save-exact @resvg/resvg-js@2.6.2
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const require=createRequire(resolve('.work/icon-tools/package.json'));
const {Resvg}=require('@resvg/resvg-js');
const root='web/judge/public',icons=join(root,'icons');
const source=name=>readFileSync(join(icons,name),'utf8');
const render=(svg,size)=>new Resvg(svg,{fitTo:{mode:'width',value:size},font:{loadSystemFonts:false}}).render().asPng();
for(const size of [16,32,48,64,96,128,144,150,152,167,180,192,256,310,384,512,1024])writeFileSync(join(icons,`icon-${size}.png`),render(source('app-icon.svg'),size));
for(const size of [192,512])writeFileSync(join(icons,`maskable-${size}.png`),render(source('maskable.svg'),size));
for(const size of [120,152,167,180])writeFileSync(join(icons,`apple-touch-${size}.png`),render(source('maskable.svg'),size));
copyFileSync(join(icons,'apple-touch-180.png'),join(root,'apple-touch-icon.png'));
copyFileSync(join(root,'brand/mark.svg'),join(root,'favicon.svg'));
const sizes=[16,32,48],pngs=sizes.map(size=>render(source('app-icon.svg'),size));
const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
for(let i=0;i<sizes.length;i++){const at=6+i*16;header[at]=sizes[i];header[at+1]=sizes[i];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(pngs[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=pngs[i].length;}
writeFileSync(join(root,'favicon.ico'),Buffer.concat([header,...pngs]));
console.log('Generated approved SVG-master icons: favicon ICO16/32/48, SVG, PNG16–1024, Apple120/152/167/180 and maskable192/512.');
