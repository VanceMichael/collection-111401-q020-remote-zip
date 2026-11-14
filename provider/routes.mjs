import { makeZip, serveRange } from './zip.mjs';
export const initialState = { generation: 1, mode: 'normal', clock: 1000 };
export async function stop(state) {  }
export async function routes(context) {
 const { request, url, body, payload, state, json, text, binary } = context;

 if(url.pathname==='/delivery')return json({delivery:'show-documents',edition:state.generation,href:'/all.zip',authorized:[{name:'allowed/a.csv'},{name:'allowed/b.csv'},{name:'same.csv'}],tailLimit:65557});
 if(url.pathname==='/all.zip'){
  if(!request.headers.range)return json({error:'禁止整包领取，请使用授权成员范围'},403);
  const entries=[['other/private.bin',Buffer.alloc(200000,7)],['allowed/a.csv','id,value\nA,'+state.generation+'\n',8,true],['allowed/b.csv','id,value\nB,5\n',0],['same.csv','first'],['same.csv','second']];
  const bytes=makeZip(entries,state.mode==='zip64');return serveRange(context,bytes,'application/zip','"delivery-'+state.generation+'"');
 }

}
