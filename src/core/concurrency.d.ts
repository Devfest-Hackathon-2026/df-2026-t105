export function mapConcurrent<T,R>(items:T[],limit:number,work:(item:T,index:number)=>Promise<R>):Promise<R[]>;
