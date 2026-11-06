export const INSTRUMENTS: Record<string, [number,string]>;
export type PartGroup = {instrument:string;program:number;name:string;role:'drums'|'bass'|'lead';notes:import('../state').Note[]};
export function roundStep(step:number):number;
export function instrumentInfo(instrument:string):{program:number;name:string;role:'drums'|'bass'|'lead'};
export function notesToParts(hits:{start:number;end:number;pitch:number;instrument:string}[],o:{bpm:number;bars:number;startSec?:number;transpose?:number;windowBeats?:number[]|null;subdivision?:number|null;quantizeStrength?:number}):PartGroup[];
export function fillEmptyBars(notes:import('../state').Note[],bars:number):import('../state').Note[];
export function consolidateStemParts(parts:PartGroup[],o:{targetRole:'drums'|'bass'|'lead';targetInstrument?:string;bars:number;fillGaps?:boolean}):{primary:PartGroup|null;others:PartGroup[]};
