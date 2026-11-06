/** Select only complete audio windows and prefer notes distributed across the requested bars. */
export function selectAlignedWindow(notes,{bpm,bars,audioDuration,firstDownbeat=0,onsetDelay=0}){
 const barSec=240/bpm,windowSec=bars*barSec;
 const last=Math.max(0,audioDuration-windowSec);
 const candidates=[];
 for(let s=firstDownbeat;s<=last+.001;s+=barSec)if(s>=0)candidates.push(s);
 if(!candidates.length)candidates.push(Math.max(0,firstDownbeat));
 let best={startSec:candidates[0],score:-Infinity};
 for(const startSec of candidates){const at=notes.filter(n=>n.start-onsetDelay>=startSec-.04&&n.start-onsetDelay<startSec+windowSec);const occupied=new Set(at.map(n=>Math.max(0,Math.floor((n.start-onsetDelay-startSec)/barSec))));const score=occupied.size*1000+Math.min(300,at.length)-startSec*.001;if(score>best.score)best={startSec,score}}
 return {startSec:best.startSec,sourceBpm:bpm,onsetDelay,completeAudio:audioDuration-best.startSec>=windowSec-.05};
}
