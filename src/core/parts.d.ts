export const INSTRUMENTS: Record<string, [number,string]>;
export function instrumentInfo(instrument:string):{program:number;name:string;role:'drums'|'bass'|'lead'};
export function notesToParts(hits:{start:number;end:number;pitch:number;instrument:string}[],o:{bpm:number;bars:number;startSec?:number;transpose?:number}):{instrument:string;program:number;name:string;role:'drums'|'bass'|'lead';notes:import('../state').Note[]}[];
