/** Bounded generation concurrency. Preserve candidate order and drain in-flight work before errors. */
export async function mapConcurrent(items,limit,work){
 const result=new Array(items.length);let next=0,error;
 async function run(){while(!error&&next<items.length){const i=next++;try{result[i]=await work(items[i],i)}catch(e){error??=e}}}
 await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,limit))},run));
 if(error)throw error;return result;
}
