/** Bound read-only evidence capture even when a native dialog suspends the page. */
export async function withDeadline<T>(label:string,operation:Promise<T>,timeoutMs:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' exceeded '+timeoutMs+' ms')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);}
}
