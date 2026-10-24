/** Real node:http parsing and ws framing over Duplex streams. No TCP or socket API replacement. */
import { Duplex } from 'node:stream';
import { createServer, get, Agent } from 'node:http';
let nextPort=30000;
const hosts=new Map();
function pair(){
  let a,b;
  const make=()=>new Duplex({
    read(){},
    write(chunk,_encoding,callback){const peer=this===a?b:a;if(peer.destroyed)callback(Error('Peer closed'));else {peer.push(Buffer.from(chunk));callback();}},
    final(callback){const peer=this===a?b:a;if(!peer.destroyed)peer.push(null);callback();},
    destroy(error,callback){const peer=this===a?b:a;if(peer&&!peer.destroyed)peer.destroy();callback(error);},
  });
  a=make();b=make();a.peer=b;b.peer=a;
  for(const stream of [a,b]){stream.setTimeout=()=>stream;stream.setNoDelay=()=>stream;stream.setKeepAlive=()=>stream;stream.on('error',()=>{});}
  return [a,b];
}
export function memoryHost(){
  const http=createServer(),port=nextPort++;let keepAlive;
  http.listen=(_port,_host,callback)=>{hosts.set(port,http);keepAlive=setInterval(()=>{},1000);queueMicrotask(callback);return http;};
  http.address=()=>({address:'127.0.0.1',family:'IPv4',port});
  http.close=callback=>{hosts.delete(port);clearInterval(keepAlive);queueMicrotask(()=>callback?.());return http;};
  return http;
}
export function createConnection(url){
  return ()=>{const server=hosts.get(Number(new URL(url).port));if(!server)throw Error('Memory host not running');const [client,peer]=pair();server.emit('connection',peer);return client;};
}
export async function memoryGet(url){
  return new Promise((resolve,reject)=>{
    const agent=new Agent();agent.createConnection=createConnection(url);
    const req=get(url,{agent},response=>{let body='';response.on('data',d=>body+=d);response.on('end',()=>{agent.destroy();resolve({status:response.statusCode,json:async()=>JSON.parse(body)});});});req.on('error',reject);
  });
}
export function occupiedHost(){const http=memoryHost();http.listen=()=>{queueMicrotask(()=>http.emit('error',new Error('Address in use')));return http;};return http;}
