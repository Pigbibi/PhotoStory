import {aspects} from './vocabulary.mjs';

// The processor emits the same three aspect labels, so they live in one place.
export const ASPECTS = Object.fromEntries(aspects.map(value => {
  const [width, height] = value.split(':').map(Number);
  return [value, width / height];
}));

export function aspectValue(value='4:5') {
  if(typeof value!=='string'||!Object.hasOwn(ASPECTS,value))throw new Error('invalid_framing');
  return value;
}
export function photoFrame(value={mode:'fit',x:50,y:50}) {
  if(!value||!['fit','crop'].includes(value.mode)||!['x','y'].every(k=>Number.isFinite(value[k])&&value[k]>=0&&value[k]<=100))throw new Error('invalid_framing');
  return {mode:value.mode,x:value.x,y:value.y};
}
export function frameStyle(aspect,frame) {
  const f=photoFrame(frame);
  return {aspectRatio:ASPECTS[aspectValue(aspect)],objectFit:f.mode==='fit'?'contain':'cover',objectPosition:`${f.x}% ${f.y}%`,background:'#fff'};
}
