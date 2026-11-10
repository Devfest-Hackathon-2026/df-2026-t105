// Explicit editable material for browser tests; the app itself starts empty.
export const editorProject=()=>({bpm:100,root:'C',bars:4,tracks:{
 lead:{id:'lead',name:'Lead',notes:[],mute:false,ghost:null},
 bass:{id:'bass',name:'Bass',notes:[{step:0,len:3,pitch:33,vel:.9},{step:16,len:3,pitch:40,vel:.8},{step:32,len:3,pitch:33,vel:.8}],mute:false,ghost:null},
},log:[]});
