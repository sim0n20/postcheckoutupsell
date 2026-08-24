import {PassThrough} from "stream";
import {renderToPipeableStream} from "react-dom/server";
import {ServerRouter, type EntryContext} from "react-router";
import {createReadableStreamFromReadable} from "@react-router/node";
import {isbot} from "isbot";
import {addDocumentResponseHeaders} from "./shopify.server";
export const streamTimeout=5000;
export default async function handleRequest(request:Request,status:number,headers:Headers,context:EntryContext){
  addDocumentResponseHeaders(request,headers);
  const callback=isbot(request.headers.get("user-agent")??"")?"onAllReady":"onShellReady";
  return new Promise<Response>((resolve,reject)=>{
    const {pipe,abort}=renderToPipeableStream(<ServerRouter context={context} url={request.url}/>,{
      [callback]:()=>{const body=new PassThrough();const stream=createReadableStreamFromReadable(body);headers.set("Content-Type","text/html");resolve(new Response(stream,{headers,status}));pipe(body)},
      onShellError:reject,
      onError(error){status=500;console.error(error)},
    });
    setTimeout(abort,streamTimeout+1000);
  });
}
