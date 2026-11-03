(()=>{
'use strict';

const $ = id => document.getElementById(id);
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
const fmt = seconds => {
  if (!Number.isFinite(seconds)) return '0:00.00';
  const s = Math.max(0, seconds);
  return `${Math.floor(s/60)}:${(s%60).toFixed(2).padStart(5, '0')}`;
};
const secs = seconds => (Number.isFinite(seconds) ? seconds : 0).toFixed(2);
const id = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const tracks = [];
let selectedId = null;
let audioContext = null;
let monitorGain = null;
let playback = null;
let raf = 0;
let loading = false;
let exporting = false;
let encoderPromise = null;
let detailZoom = 1.5;
let cursor = 0;
const MIN_GAP = 0.02;

function current() { return tracks.find(t => t.id === selectedId) || null; }
function toast(message, error=false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  $('toastBox').append(element);
  setTimeout(() => element.remove(), 3800);
}
function context() {
  if (!audioContext) {
    const Class = window.AudioContext || window.webkitAudioContext;
    if (!Class) throw Error('このブラウザは Web Audio API に対応していません');
    audioContext = new Class();
    monitorGain = audioContext.createGain();
    monitorGain.gain.value = Number($('volumeSlider').value)/100;
    monitorGain.connect(audioContext.destination);
  }
  return audioContext;
}
function baseName(name) {
  return name.replace(/\.(?:mp3|wav|m4a|aac|ogg|flac)$/i, '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 110) || 'music';
}
function minKeep(t) { return Math.min(0.1, t.duration/8); }
function fadeMax(t) { return Math.max(0, Math.min(5, t.cutIn-0.001, t.duration-t.cutOut-0.001)); }
function actualFade(t) { return Math.min(t.fade, fadeMax(t)); }
function resultingSeconds(t) { return Math.max(0, t.duration-(t.cutOut-t.cutIn)-actualFade(t)); }
function beatInterval(t) { return 60/clamp(t.bpm, 30, 300)*t.snapUnit; }
function snap(t, seconds) { return t.snapEnabled ? Math.round(seconds/beatInterval(t))*beatInterval(t) : seconds; }
function invalidate(t, stopPlayback=true) {
  t.processed = null;
  t.seamBuffer = null;
  if (stopPlayback) stop();
  if (t === current()) { refresh(); drawAll(); }
}
function setCut(which, time, useSnap=false) {
  const t = current();
  if (!t || exporting || !Number.isFinite(time)) return;
  const requested = useSnap ? snap(t,time) : time;
  if (which === 'in') t.cutIn = clamp(requested, minKeep(t), t.cutOut-MIN_GAP);
  else t.cutOut = clamp(requested, t.cutIn+MIN_GAP, t.duration-minKeep(t));
  invalidate(t);
}
function cursorSet(time) {
  const t = current();
  if (!t) return;
  cursor = clamp(time, 0, t.duration);
  drawWave();
}
function chooseTrack(trackId) {
  if (exporting) return;
  stop();
  selectedId = trackId;
  cursor = 0;
  render();
}

function createPeaks(buffer, count=2500) {
  const samples = buffer.length;
  const channels = Array.from({length:buffer.numberOfChannels}, (_,i) => buffer.getChannelData(i));
  const peaks = new Float32Array(count*2);
  for (let i=0; i<count; i++) {
    let low=1, high=-1;
    const start = Math.floor(i*samples/count);
    const end = Math.max(start+1, Math.floor((i+1)*samples/count));
    const step = Math.max(1, Math.floor((end-start)/100));
    for (let k=start; k<end; k+=step) {
      for (const data of channels) {
        const v=data[k];
        if (v<low) low=v;
        if (v>high) high=v;
      }
    }
    peaks[i*2]=low;
    peaks[i*2+1]=high;
  }
  return peaks;
}
async function loadFiles(files) {
  if (loading || exporting) { toast('ほかの処理が終わってから追加してください',true); return; }
  const accepts = [...files].filter(f => /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(f.name) || f.type.startsWith('audio/'));
  if (!accepts.length) { toast('対応する音声ファイルを選択してください',true); return; }
  loading=true;
  let count=0;
  for (const file of accepts) {
    if (file.size > 250*1024*1024) { toast(`${file.name}: 250MB以内の音源を選択してください`,true); continue; }
    try {
      const buffer = await context().decodeAudioData(await file.arrayBuffer());
      if (buffer.duration < 0.5) throw Error('音声が短すぎます（0.5秒以上必要）');
      if (buffer.numberOfChannels > 2) throw Error('モノラルまたはステレオ音声をご利用ください');
      const duration=buffer.duration;
      const wanted=Math.min(60, duration*0.60);
      const fade=Math.min(0.20, wanted*0.03);
      const keep=wanted+fade;
      const cutIn=keep*0.60;
      const cutOut=duration-keep*0.40;
      const track={id:id(),name:file.name,audio:buffer,duration,cutIn,cutOut,fade,shape:'equal',
        bpm:120,snapUnit:4,snapEnabled:false,peaks:createPeaks(buffer),processed:null,seamBuffer:null};
      tracks.push(track);
      selectedId=track.id;
      cursor=0;
      count++;
      render();
    } catch (e) { toast(`${file.name}: 読み込めませんでした（${e.message}）`,true); }
  }
  loading=false;
  if (count) toast(`${count}曲を読み込みました`);
  render();
}
function renderFiles() {
  $('fileCount').textContent=`${tracks.length} 曲`;
  const list=$('fileList'); list.replaceChildren();
  for (const t of tracks) {
    const row=document.createElement('div');
    row.className=`file-item${t.id===selectedId?' active':''}`;
    row.tabIndex=0; row.setAttribute('role','button'); row.setAttribute('aria-label',`${t.name}を編集`);
    const icon=document.createElement('div'); icon.className='file-icon';
    icon.textContent=t.name.split('.').pop().toUpperCase().slice(0,4);
    const body=document.createElement('div');body.className='file-body';
    const name=document.createElement('div');name.className='file-name';name.title=t.name;name.textContent=t.name;
    const info=document.createElement('div');info.className='file-sub';info.textContent=`${fmt(t.duration)} → ${fmt(resultingSeconds(t))}`;
    body.append(name,info);
    const remove=document.createElement('button');remove.className='remove';remove.textContent='×';remove.title='この曲を削除';
    remove.onclick=e => { e.stopPropagation(); if (exporting) return; stop(); const at=tracks.indexOf(t);
      tracks.splice(at,1);if (selectedId===t.id) selectedId=tracks[Math.max(0,at-1)]?.id||null;cursor=0;render(); };
    row.onclick=()=>chooseTrack(t.id);
    row.onkeydown=e=>{if(e.target===row && (e.key==='Enter'||e.key===' ')){e.preventDefault();chooseTrack(t.id);}};
    row.append(icon,body,remove);list.append(row);
  }
}
function render() {
  const t=current();renderFiles();
  $('workspace').hidden=!t;$('emptyState').hidden=!!t;
  $('trackTitle').textContent=t?t.name:'フル尺から、ちょうどいいショート版を。';
  $('trackDesc').textContent=t?`${(t.audio.sampleRate/1000).toFixed(1)} kHz · ${t.audio.numberOfChannels===1?'モノラル':'ステレオ'} · 元曲 ${fmt(t.duration)} · 中間だけをカット`:'音声を読み込むと、曲全体の波形が表示されます。';
  $('trackBadge').textContent=t?'SHORT EDITING':'READY TO START';
  $('exportOne').disabled=exporting||!t;
  $('exportAll').disabled=exporting||!tracks.length;
  $('clearAll').disabled=exporting;
  if (!t) {
    $('summaryDuration').textContent='0:00.00';$('originalDuration').textContent='0:00.00';
    $('removedDuration').textContent='−0:00.00';$('overlapDuration').textContent='−0.00 秒';$('shortRatio').textContent='0%';
    updateTransport();return;
  }
  $('fadeShape').value=t.shape;
  $('bpmInput').value=String(t.bpm);
  $('snapUnit').value=String(t.snapUnit);
  $('snapEnabled').checked=t.snapEnabled;
  refresh();
  updateTransport();
  requestAnimationFrame(drawAll);
}
function refresh() {
  const t=current();if(!t)return;
  const f=actualFade(t);
  $('cutInInput').value=secs(t.cutIn);$('cutOutInput').value=secs(t.cutOut);
  $('cutInInput').max=secs(t.duration);$('cutOutInput').max=secs(t.duration);
  $('rangeText').textContent=`削除する区間　${fmt(t.cutIn)} — ${fmt(t.cutOut)}`;
  $('selectedDuration').textContent=`カット ${fmt(t.cutOut-t.cutIn)}`;
  $('detailInTime').textContent=`${secs(t.cutIn)} 秒`;
  $('detailOutTime').textContent=`${secs(t.cutOut)} 秒`;
  $('fadeSlider').max=String(Math.max(0,Math.round(fadeMax(t)*1000)));
  $('fadeSlider').value=String(Math.round(f*1000));
  $('fadeValue').textContent=`${secs(f)} 秒`;
  $('fadeMax').textContent=`${secs(fadeMax(t))}秒`;
  $('seamDesc').textContent=`クロスフェード ${secs(f)}秒`;
  $('summaryDuration').textContent=fmt(resultingSeconds(t));
  $('originalDuration').textContent=fmt(t.duration);
  $('removedDuration').textContent='−'+fmt(t.cutOut-t.cutIn);
  $('overlapDuration').textContent='−'+secs(f)+' 秒';
  $('shortRatio').textContent=Math.round((1-resultingSeconds(t)/t.duration)*100)+'%';
  renderFiles();
}
function applyTarget(raw) {
  const t=current();if(!t)return;
  const wanted=Number(raw);
  if (!Number.isFinite(wanted)||wanted<0.1) { toast('目標の秒数を正しく入力してください',true);return; }
  if (wanted>=t.duration-0.05) { toast('元曲より短い秒数を指定してください',true);return; }
  const target=Math.max(0.1,wanted);
  const overlap=Math.min(t.fade,5,target*.15);
  const retained=target+overlap;
  // Choose front:back = 60:40, then recompute using the effective fade so the target is sample-close.
  t.cutIn=retained*.60;
  t.cutOut=t.duration-retained*.40;
  t.fade=overlap;
  if (actualFade(t)<overlap) {
    const safe=actualFade(t);const sum=target+safe;
    t.cutIn=sum*.60;t.cutOut=t.duration-sum*.40;
  }
  cursor=0;
  invalidate(t);
  toast(`約${fmt(resultingSeconds(t))}のショート版に調整しました`);
}

// The first section ends at CUT IN; the second begins at CUT OUT.
// Overlap the trailing F samples of section A with the leading F samples of section B.
// The actual output duration is A + B - F, not a loop.
function processed(t) {
  if (t.processed) return t.processed;
  const input=t.audio, rate=input.sampleRate;
  const a=clamp(Math.round(t.cutIn*rate),1,input.length-2);
  const b=clamp(Math.round(t.cutOut*rate),a+1,input.length-1);
  const left=a, right=input.length-b;
  const overlap=clamp(Math.round(actualFade(t)*rate),0,Math.min(left,right));
  const outLength=left+right-overlap;
  const output=context().createBuffer(input.numberOfChannels,outLength,rate);
  const prefix=left-overlap;
  let peak=0;
  for (let ch=0;ch<input.numberOfChannels;ch++) {
    const src=input.getChannelData(ch);
    const dst=output.getChannelData(ch);
    dst.set(src.subarray(0,prefix),0);
    if (overlap===0) {
      dst.set(src.subarray(b),left);
    } else {
      for (let i=0;i<overlap;i++) {
        const mix=overlap===1?0.5:i/(overlap-1);
        const gl=t.shape==='linear'?1-mix:Math.cos(mix*Math.PI/2);
        const gr=t.shape==='linear'?mix:Math.sin(mix*Math.PI/2);
        dst[prefix+i]=src[prefix+i]*gl+src[b+i]*gr;
      }
      dst.set(src.subarray(b+overlap),left);
    }
    // Only compensate overload caused by summing the two sources; do not normalize quiet music.
    for (let i=0;i<outLength;i++) peak=Math.max(peak,Math.abs(dst[i]));
  }
  if (peak>0.999) {
    const gain=0.999/peak;
    for (let ch=0;ch<output.numberOfChannels;ch++) {
      const dst=output.getChannelData(ch);
      for (let i=0;i<outLength;i++) dst[i]*=gain;
    }
  }
  t.processed=output;
  return output;
}
function clippedBuffer(source,start,end) {
  const first=clamp(Math.floor(start*source.sampleRate),0,source.length-1);
  const last=clamp(Math.ceil(end*source.sampleRate),first+1,source.length);
  const target=context().createBuffer(source.numberOfChannels,last-first,source.sampleRate);
  for (let ch=0;ch<source.numberOfChannels;ch++) target.copyToChannel(source.getChannelData(ch).subarray(first,last),ch);
  return target;
}
function seam(t) {
  if(t.seamBuffer) return t.seamBuffer;
  const output=processed(t);
  const join=t.cutIn-actualFade(t);
  t.seamBuffer=clippedBuffer(output,Math.max(0,join-2.5),Math.min(output.duration,join+2.5));
  return t.seamBuffer;
}

function stopNode() {
  if (!playback?.node) return;
  const node=playback.node;
  node.onended=null;
  try { node.stop(); } catch (_) {}
  try { node.disconnect(); } catch (_) {}
  playback.node=null;
}
function stop() {
  stopNode();playback=null;
  cancelAnimationFrame(raf);raf=0;
  for(const button of ['playOriginal','playShort','playJoin']) $(button).classList.remove('active');
  $('playPause').disabled=true;$('stopPlay').disabled=true;$('playPause').textContent='Ⅱ 一時停止';
  updateTransport();
}
function updateTransport() {
  const t=current();
  const dur=playback?.buffer.duration ?? (t?resultingSeconds(t):0);
  const pos=playback?position():0;
  $('seekBar').disabled=!playback;
  $('seekBar').value=String(dur?Math.round(clamp(pos,0,dur)/dur*1000):0);
  $('currentTime').textContent=fmt(pos);
  $('totalTime').textContent=fmt(dur);
}
function position() {
  if(!playback) return 0;
  if(!playback.node) return playback.offset;
  return clamp(playback.offset+context().currentTime-playback.startedAt,0,playback.buffer.duration);
}
function setPlayheadFromAudio() {
  const t=current();if(!t||!playback)return;
  const p=position();
  if (playback.mode==='original') cursor=p;
  else if (playback.mode==='short') {
    const transition=t.cutIn-actualFade(t);
    cursor=p<transition?p:Math.min(t.duration,t.cutOut+(p-transition));
  }
}
function tick() {
  if(!playback?.node){raf=0;return;}
  updateTransport();setPlayheadFromAudio();drawWave();
  raf=requestAnimationFrame(tick);
}
async function playMode(mode,start=0) {
  const t=current();if(!t||exporting)return;
  try {
    stop();
    const ac=context();await ac.resume();
    const buffer=mode==='original'?t.audio:mode==='short'?processed(t):seam(t);
    playback={mode,buffer,node:null,offset:clamp(start,0,Math.max(0,buffer.duration-.001)),startedAt:0};
    if (mode==='original') cursor=playback.offset;
    const labels={original:'元のフル尺を再生中。波形をクリックすると次の再生開始位置を指定できます。',short:'カット済みのショート版を再生中。完成版は最後で停止します。',join:'接続箇所を中心に前後約2.5秒だけ再生しています。'};
    $('playMessage').textContent=labels[mode];
    resumePlayback();
  } catch(e) {stop();toast(`試聴できません：${e.message}`,true);}
}
function resumePlayback() {
  if(!playback)return;
  stopNode();
  const ac=context();const p=playback;
  if(p.offset>=p.buffer.duration-.001) p.offset=0;
  const node=ac.createBufferSource();node.buffer=p.buffer;node.connect(monitorGain);
  node.onended=()=>{
    if(!playback||playback.node!==node)return;
    playback.offset=playback.buffer.duration;
    playback.node=null;cancelAnimationFrame(raf);raf=0;
    $('playPause').disabled=true;
    $('playPause').textContent='Ⅱ 一時停止';
    $('stopPlay').disabled=false;
    for(const button of ['playOriginal','playShort','playJoin']) $(button).classList.remove('active');
    $('playMessage').textContent='最後まで再生しました。繰り返し再生はしません。';
    updateTransport();drawWave();
  };
  p.startedAt=ac.currentTime;p.node=node;
  node.start(0,p.offset);
  const active={original:'playOriginal',short:'playShort',join:'playJoin'}[p.mode];
  for(const button of ['playOriginal','playShort','playJoin']) $(button).classList.toggle('active',button===active);
  $('playPause').disabled=false;$('stopPlay').disabled=false;
  $('playPause').textContent='Ⅱ 一時停止';
  cancelAnimationFrame(raf);raf=requestAnimationFrame(tick);
  updateTransport();
}
async function togglePause() {
  if(!playback)return;
  if(playback.node) {
    playback.offset=position();stopNode();cancelAnimationFrame(raf);raf=0;
    $('playPause').textContent='▶ 再開';$('playMessage').textContent='一時停止中です。';
  } else {
    try {await context().resume();resumePlayback();} catch(e){toast(e.message,true);}
  }
  updateTransport();
}
async function seekTo(ratio) {
  if(!playback)return;
  const playing=!!playback.node;
  playback.offset=clamp(ratio,0,1)*playback.buffer.duration;
  if(playing) {
    try {await context().resume();resumePlayback();} catch(e){toast(e.message,true);}
  } else updateTransport();
  setPlayheadFromAudio();drawWave();
}

function canvasPrep(id) {
  const el=$(id),rect=el.getBoundingClientRect();
  if(!rect.width||!rect.height)return null;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const w=rect.width,h=rect.height;
  if(el.width!==Math.round(w*dpr)||el.height!==Math.round(h*dpr)){
    el.width=Math.round(w*dpr);el.height=Math.round(h*dpr);
  }
  const g=el.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  return {g,w,h};
}
function roundRect(ctx,x,y,width,height,r,color) {
  if(width<=0)return;
  ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,width,height,r);ctx.fill();
}
function drawWave() {
  const t=current();if(!t)return;
  const data=canvasPrep('waveCanvas');if(!data)return;
  const {g,w,h}=data;const left=12,right=w-12,top=25,bottom=h-25,pw=right-left;
  const xAt=time=>left+clamp(time/t.duration,0,1)*pw;
  const x1=xAt(t.cutIn), x2=xAt(t.cutOut), mid=(top+bottom)*.5;
  g.fillStyle='#fffaf3';g.fillRect(0,0,w,h);
  g.fillStyle='#edf3e9';g.fillRect(left,top,x1-left,bottom-top);
  g.fillStyle='#f8dfd1';g.fillRect(x1,top,x2-x1,bottom-top);
  g.fillStyle='#f8ebdd';g.fillRect(x2,top,right-x2,bottom-top);
  g.save();g.beginPath();g.rect(x1,top,x2-x1,bottom-top);g.clip();
  g.strokeStyle='#d69f8750';g.lineWidth=1;
  for(let x=x1-(top%14)-100;x<x2+100;x+=13){g.beginPath();g.moveTo(x,top);g.lineTo(x+40,bottom);g.stroke();}
  g.restore();
  // Time ruler with labels, adaptive to song length.
  const stepCandidates=[1,2,5,10,15,30,60,120,300,600];
  const step=stepCandidates.find(s=>t.duration/s <= Math.max(4,pw/85))||600;
  g.font='10px system-ui';g.textBaseline='middle';g.textAlign='center';
  for(let s=0;s<=t.duration+.0001;s+=step){const x=xAt(s);g.strokeStyle='#d9c6b681';g.beginPath();g.moveTo(x,top);g.lineTo(x,bottom);g.stroke();g.fillStyle='#aa8a73';g.fillText(`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`,x,13);}
  g.setLineDash([2,3]);g.strokeStyle='#b99d8980';g.beginPath();g.moveTo(left,mid);g.lineTo(right,mid);g.stroke();g.setLineDash([]);
  const bins=t.peaks.length/2;const amplitude=(bottom-top)*.45;
  const bars=Math.max(1,Math.floor(pw));g.lineWidth=1.25;
  for(let px=0;px<bars;px+=1.3){const frac=px/pw;const idx=Math.min(bins-1,Math.floor(frac*bins));
    const low=t.peaks[idx*2],high=t.peaks[idx*2+1],x=left+px;
    g.strokeStyle=x>=x1&&x<=x2?'#b89583':x<x1?'#678c76':'#b98260';
    g.beginPath();g.moveTo(x,mid+low*amplitude);g.lineTo(x,mid+high*amplitude);g.stroke();
  }
  // Strong boundary strokes and small name tags.
  function marker(x,color,name,align) {
    g.strokeStyle=color;g.lineWidth=2;g.beginPath();g.moveTo(x,top-3);g.lineTo(x,bottom+3);g.stroke();
    const ww=64;const xx=align==='right'?clamp(x-ww,2,w-ww-2):clamp(x,2,w-ww-2);
    roundRect(g,xx,top+6,ww,22,5,color);
    g.fillStyle='white';g.font='bold 10px system-ui';g.fillText(name,xx+ww/2,top+17);
    g.beginPath();g.moveTo(x-6,bottom+3);g.lineTo(x+6,bottom+3);g.lineTo(x,bottom-3);g.closePath();g.fillStyle=color;g.fill();
  }
  marker(x1,'#678c76','CUT IN','right');marker(x2,'#bd7c55','CUT OUT','left');
  const pointer=xAt(cursor);
  g.strokeStyle='#604076';g.lineWidth=1.5;g.setLineDash([4,3]);g.beginPath();g.moveTo(pointer,top);g.lineTo(pointer,bottom);g.stroke();g.setLineDash([]);
  g.beginPath();g.arc(pointer,mid,4.2,0,Math.PI*2);g.fillStyle='#604076';g.fill();
}
function drawDetail(which) {
  const t=current();if(!t)return;
  const data=canvasPrep(which==='in'?'inDetail':'outDetail');if(!data)return;
  const {g,w,h}=data;const marker=which==='in'?t.cutIn:t.cutOut;
  const center=h/2,half=detailZoom, sr=t.audio.sampleRate;
  const chans=Array.from({length:t.audio.numberOfChannels},(_,i)=>t.audio.getChannelData(i));
  g.fillStyle='#fff9f0';g.fillRect(0,0,w,h);
  g.fillStyle=which==='in'?'#eaf2e7':'#f4e3d5';g.fillRect(0,0,w/2,h);
  g.strokeStyle='#e3d3c4';g.beginPath();g.moveTo(0,center);g.lineTo(w,center);g.stroke();
  const span=half*2;
  for (let x=1;x<w;x+=2) {
    const at=marker-half+x/w*span;
    const start=Math.floor(Math.max(0,at)*sr);
    const end=Math.floor(Math.min(t.duration,at+span/w*2)*sr);
    if(end<=start||at>t.duration)continue;
    const step=Math.max(1,Math.floor((end-start)/40));
    let low=1,high=-1;
    for(let i=start;i<end;i+=step)for(const ch of chans){if(ch[i]<low)low=ch[i];if(ch[i]>high)high=ch[i];}
    g.strokeStyle=which==='in'?'#809e87':'#bf8e6c';g.lineWidth=1.3;g.beginPath();g.moveTo(x,center+low*h*.42);g.lineTo(x,center+high*h*.42);g.stroke();
  }
  g.strokeStyle=which==='in'?'#558069':'#bd8059';g.lineWidth=2;
  g.beginPath();g.moveTo(w/2,0);g.lineTo(w/2,h);g.stroke();
  g.fillStyle='#8e7261';g.font='9px system-ui';g.textAlign='left';g.fillText(`−${secs(half)}s`,5,h-6);
  g.textAlign='right';g.fillText(`+${secs(half)}s`,w-5,h-6);
}
function drawSeam() {
  const t=current();if(!t)return;
  const data=canvasPrep('seamCanvas');if(!data)return;
  const {g,w,h}=data,margin=30,top=22,bottom=h-24,available=w-margin*2;
  g.fillStyle='#fffbf5';g.fillRect(0,0,w,h);
  const left=margin+available*.26,right=margin+available*.74;
  g.fillStyle='#f4e7d8';g.fillRect(left,top,right-left,bottom-top);
  g.strokeStyle='#dcc9b6';g.setLineDash([3,4]);
  for(let i=0;i<=4;i++){const y=bottom-(bottom-top)*i/4;g.beginPath();g.moveTo(margin,y);g.lineTo(w-margin,y);g.stroke();}
  g.setLineDash([]);
  const f=actualFade(t);
  const envelopes=[{color:'#638b72',fn:x=>x<=left?1:x>=right?0:t.shape==='linear'?1-(x-left)/(right-left):Math.cos((x-left)/(right-left)*Math.PI/2)},
    {color:'#be825e',fn:x=>x<=left?0:x>=right?1:t.shape==='linear'?(x-left)/(right-left):Math.sin((x-left)/(right-left)*Math.PI/2)}];
  for(const item of envelopes){g.strokeStyle=item.color;g.lineWidth=2.8;g.beginPath();for(let x=margin;x<=w-margin;x+=2){const y=bottom-item.fn(x)*(bottom-top);if(x===margin)g.moveTo(x,y);else g.lineTo(x,y);}g.stroke();}
  g.fillStyle='#9b7c68';g.font='10px system-ui';g.textAlign='center';
  g.fillText(f>0?`重なる時間 ${secs(f)}秒`:'0秒：音を重ねずにつなぎます',w/2,13);
  g.fillText('前半',margin+17,h-8);g.fillText('後半',w-margin-17,h-8);
  g.strokeStyle='#cca489';g.setLineDash([5,3]);g.beginPath();g.moveTo(left,top);g.lineTo(left,bottom);g.moveTo(right,top);g.lineTo(right,bottom);g.stroke();g.setLineDash([]);
}
function drawAll() { if(!current()) return;drawWave();drawDetail('in');drawDetail('out');drawSeam(); }
function bindWave() {
  const el=$('waveCanvas');let drag=null;
  function locate(e) {const r=el.getBoundingClientRect();return clamp((e.clientX-r.left-12)/(r.width-24),0,1)*current().duration;}
  el.addEventListener('pointerdown',e=>{
    const t=current();if(!t||exporting)return;
    const time=locate(e),pixels=el.getBoundingClientRect().width-24;
    const a=Math.abs(time-t.cutIn)/t.duration*pixels,b=Math.abs(time-t.cutOut)/t.duration*pixels;
    drag=Math.min(a,b)<19?(a<=b?'in':'out'):'cursor';
    el.setPointerCapture(e.pointerId);
    if(drag==='cursor') cursorSet(time);else setCut(drag,time,true);
  });
  el.addEventListener('pointermove',e=>{if(!drag||!current())return;if(drag==='cursor') cursorSet(locate(e));else setCut(drag,locate(e),true);});
  function done(){drag=null;}
  el.addEventListener('pointerup',done);el.addEventListener('pointercancel',done);el.addEventListener('lostpointercapture',done);
}
function bindDetail(which) {
  const el=$(which==='in'?'inDetail':'outDetail');let dragging=false,origin=0;
  const locate=e=>origin+((e.clientX-el.getBoundingClientRect().left)/el.getBoundingClientRect().width-.5)*2*detailZoom;
  el.addEventListener('pointerdown',e=>{const t=current();if(!t||exporting)return;origin=which==='in'?t.cutIn:t.cutOut;dragging=true;el.setPointerCapture(e.pointerId);setCut(which,locate(e),false);});
  el.addEventListener('pointermove',e=>{if(dragging)setCut(which,locate(e),false);});
  const done=()=>{dragging=false;};el.addEventListener('pointerup',done);el.addEventListener('pointercancel',done);el.addEventListener('lostpointercapture',done);
}

function waveBlob(buffer) {
  const channels=buffer.numberOfChannels,samples=buffer.length,bytesPerFrame=channels*2;
  if(samples*bytesPerFrame > 0xFFFFFF00) throw Error('音声が大きすぎてWAVに保存できません');
  const ab=new ArrayBuffer(44+samples*bytesPerFrame),v=new DataView(ab);
  const string=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i));};
  string(0,'RIFF');v.setUint32(4,36+samples*bytesPerFrame,true);string(8,'WAVE');string(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,buffer.sampleRate,true);
  v.setUint32(28,buffer.sampleRate*bytesPerFrame,true);v.setUint16(32,bytesPerFrame,true);v.setUint16(34,16,true);
  string(36,'data');v.setUint32(40,samples*bytesPerFrame,true);
  const data=Array.from({length:channels},(_,i)=>buffer.getChannelData(i));let offset=44;
  for(let i=0;i<samples;i++)for(let ch=0;ch<channels;ch++){
    const x=clamp(data[ch][i],-1,1);v.setInt16(offset,x<0?Math.round(x*32768):Math.round(x*32767),true);offset+=2;
  }
  return new Blob([ab],{type:'audio/wav'});
}
async function resample(buffer,newRate) {
  if(buffer.sampleRate===newRate)return buffer;
  const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!Offline)throw Error('このブラウザは音声のサンプルレート変更に対応していません');
  const offline=new Offline(buffer.numberOfChannels,Math.max(1,Math.round(buffer.duration*newRate)),newRate);
  const src=offline.createBufferSource();src.buffer=buffer;src.connect(offline.destination);src.start(0);
  return offline.startRendering();
}
async function loadMp3Encoder() {
  if(window.lamejs?.Mp3Encoder)return;
  if(encoderPromise)return encoderPromise;
  const urls=['https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.all.min.js','https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.min.js'];
  encoderPromise=(async()=>{
    for (const url of urls) {
      try {
        await new Promise((resolve,reject)=>{
          const script=document.createElement('script');script.src=url;script.onload=resolve;
          script.onerror=()=>reject(Error('MP3エンコーダーを取得できません'));document.head.append(script);
        });
        if(window.lamejs?.Mp3Encoder)return;
      } catch(_) {}
    }
    throw Error('MP3変換用ライブラリを読み込めません。ネット接続を確認してください');
  })();
  try {await encoderPromise;} catch(e){encoderPromise=null;throw e;}
}
async function mp3Blob(buffer,bitrate,progress) {
  await loadMp3Encoder();
  const channels=buffer.numberOfChannels;
  const encoder=new window.lamejs.Mp3Encoder(channels,buffer.sampleRate,bitrate);
  const srcs=Array.from({length:channels},(_,i)=>buffer.getChannelData(i));
  const result=[];
  const block=1152;
  for(let offset=0;offset<buffer.length;offset+=block){
    const count=Math.min(block,buffer.length-offset);
    const pcm=srcs.map(src=>{
      const arr=new Int16Array(count);
      for(let i=0;i<count;i++){const x=clamp(src[offset+i],-1,1);arr[i]=x<0?Math.round(x*32768):Math.round(x*32767);}
      return arr;
    });
    const chunk=channels===2?encoder.encodeBuffer(pcm[0],pcm[1]):encoder.encodeBuffer(pcm[0]);
    if(chunk.length)result.push(new Uint8Array(chunk));
    if((offset/block)%200===0){progress?.(offset/buffer.length);await new Promise(resolve=>setTimeout(resolve,0));}
  }
  const tail=encoder.flush();if(tail.length)result.push(new Uint8Array(tail));
  progress?.(1);
  return new Blob(result,{type:'audio/mpeg'});
}
function download(blob,filename) {
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),20000);
}
// A simple ZIP store writer, so multi-track exports work without a ZIP dependency.
const CRC_TABLE=(()=>{const a=new Uint32Array(256);for(let i=0;i<256;i++){let v=i;for(let j=0;j<8;j++)v=(v&1)?0xedb88320^(v>>>1):v>>>1;a[i]=v>>>0;}return a;})();
function crc32(bytes){let c=0xFFFFFFFF;for(const v of bytes)c=CRC_TABLE[(c^v)&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}
async function zipBlob(entries) {
  const encoder=new TextEncoder(),localParts=[],centralParts=[];
  const now=new Date();const dt=(now.getHours()<<11)|(now.getMinutes()<<5)|Math.floor(now.getSeconds()/2);
  const dd=((Math.max(1980,now.getFullYear())-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
  let offset=0;
  for (const entry of entries) {
    const name=encoder.encode(entry.name),data=new Uint8Array(await entry.blob.arrayBuffer());
    const crc=crc32(data);
    const local=new Uint8Array(30+name.length),l=new DataView(local.buffer);
    l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);
    l.setUint16(10,dt,true);l.setUint16(12,dd,true);l.setUint32(14,crc,true);
    l.setUint32(18,data.length,true);l.setUint32(22,data.length,true);l.setUint16(26,name.length,true);
    local.set(name,30);localParts.push(local,entry.blob);
    const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
    c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);
    c.setUint16(8,0x800,true);c.setUint16(12,dt,true);c.setUint16(14,dd,true);
    c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);
    c.setUint16(28,name.length,true);c.setUint32(42,offset,true);
    central.set(name,46);centralParts.push(central);offset+=local.length+data.length;
  }
  const centralSize=centralParts.reduce((a,p)=>a+p.length,0);
  if(offset+centralSize>0xFFFFFFFF)throw Error('ZIPが4GBを超えます。曲ごとに保存してください');
  const end=new Uint8Array(22),e=new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);
  e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  return new Blob([...localParts,...centralParts,end],{type:'application/zip'});
}
function busy(flag) {
  exporting=flag;
  for(const button of ['exportOne','exportAll','topAdd','chooseFiles','clearAll'])$(button).disabled=flag||((button==='exportOne')&&!current())||((button==='exportAll')&&!tracks.length);
  $('progressTrack').hidden=!flag;
  if(!flag)$('progressFill').style.width='0%';
}
function exportProgress(message,percent) {
  $('exportStatus').textContent=message;
  if(percent!==undefined)$('progressFill').style.width=`${clamp(percent,0,100)}%`;
}
async function toFile(t,progress) {
  let buffer=processed(t);
  let rate=$('rateSelect').value==='original'?buffer.sampleRate:Number($('rateSelect').value);
  const format=$('formatSelect').value;
  if(format==='mp3' && ![32000,44100,48000].includes(rate)) rate=44100;
  buffer=await resample(buffer,rate);
  if(format==='wav')return waveBlob(buffer);
  return mp3Blob(buffer,Number($('bitrateSelect').value),progress);
}
async function exportTracks(batch) {
  if(exporting||!current())return;
  const list=batch?[...tracks]:[current()];
  if(list.length>100){toast('一括保存は100曲までです',true);return;}
  stop();busy(true);
  try {
    const entries=[],used=new Set();const ext=$('formatSelect').value;
    for(let i=0;i<list.length;i++) {
      const t=list[i];
      exportProgress(`${i+1}/${list.length}：${t.name} を書き出しています`,i/list.length*100);
      await new Promise(resolve=>setTimeout(resolve,0));
      const blob=await toFile(t,fraction=>exportProgress(`${i+1}/${list.length}：MP3に変換中 ${Math.floor(fraction*100)}%`,(i+fraction)/list.length*100));
      const base=baseName(t.name)+'_short';let name=base+'.'+ext,counter=2;
      while(used.has(name.toLowerCase()))name=`${base}_${counter++}.${ext}`;
      used.add(name.toLowerCase());entries.push({name,blob});
    }
    if(batch)download(await zipBlob(entries),'short_tracks.zip');
    else download(entries[0].blob,entries[0].name);
    exportProgress(`${entries.length}曲の保存が完了しました`,100);
    toast('ショート版を書き出しました');
  } catch(e) {exportProgress(`保存失敗：${e.message}`);toast(`書き出しエラー：${e.message}`,true);}
  finally {busy(false);render();}
}
function help() {
  $('modalRoot').innerHTML=`<div class="modal-mask"><div class="modal" role="dialog" aria-modal="true" aria-label="使い方"><div class="modal-title">☕ ショート仕立ての使い方 <button id="closeHelp" aria-label="閉じる">×</button></div><div class="modal-content">
  <h3>① 音源を読み込む</h3><p>WAV、MP3などをドラッグ＆ドロップ。ブラウザで再生できる形式に対応します。複数曲も追加可能です。</p>
  <h3>② 真ん中のカット範囲を選ぶ</h3><p>波形上の <strong>緑「CUT IN」</strong> が前半の終点、<strong>オレンジ「CUT OUT」</strong> が後半の始点。ふたつの間（薄い赤色の範囲）が削除されます。マーカーのドラッグ、時刻の直接入力、±0.01秒ボタン、拡大波形で調整できます。波形の空白をクリックすると紫色のカーソルを移動でき、その位置から元曲を再生したり、マーカーに反映したりできます。</p>
  <h3>③ 目標の秒数でざっくり配置</h3><p>15〜120秒、または任意の尺を適用すると、曲頭を約60%、曲末を約40%残す形に自動配置します。フレーズや拍を考慮した自動解析ではないので、耳で聴いて手動調整してください。</p>
  <h3>④ フェードの長さと拍を調整</h3><p>クロスフェードは前半の終わりと後半の始まりを短時間だけ重ねて自然につなぎます。0秒なら単純な切り貼り。BPMを手動入力し「マーカーを拍にスナップ」をオンにすると、全体波形でマーカーをドラッグしたとき拍の区切りに吸着します。拡大波形と数値入力は自由に微調整できます。</p>
  <h3>⑤ 聴き比べて書き出す</h3><p>「元のフル尺」「ショート版を試聴」「つなぎ目だけ」を切り替えられます。再生は1回で停止しループしません。WAVかMP3を選び、1曲または全曲ZIP保存できます。WAVは完全オフライン。MP3保存時はエンコーダー読み込みにネット接続が必要です。</p>
  <h3>編集の注意</h3><p>テンポや小節、旋律、歌詞が合わない位置はフェードだけでは音楽的につながりません。最も自然な切れ目を前後で探してください。出力長は<strong>「元曲の長さ − カットした中間 − 重ねたフェード」</strong>になります。データはブラウザを閉じると消えるので、完成した音源は必ず保存してください。</p>
  </div></div></div>`;
  $('closeHelp').onclick=()=>$('modalRoot').replaceChildren();
  $('modalRoot').querySelector('.modal-mask').onclick=e=>{if(e.target.classList.contains('modal-mask'))$('modalRoot').replaceChildren();};
}

// UI handlers
for(const name of ['chooseFiles','topAdd','emptyAdd'])$(name).onclick=()=>$('filePicker').click();
$('filePicker').onchange=e=>{loadFiles(e.target.files);e.target.value='';};
const dropZone=$('dropZone');
for(const element of [dropZone,$('emptyState')]){
  element.addEventListener('dragover',e=>{e.preventDefault();dropZone.classList.add('drag');});
  element.addEventListener('dragleave',()=>dropZone.classList.remove('drag'));
  element.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('drag');loadFiles(e.dataTransfer.files);});
}
$('clearAll').onclick=()=>{if(!tracks.length||exporting)return;if(!confirm('すべての音源と編集設定を削除しますか？'))return;stop();tracks.length=0;selectedId=null;cursor=0;render();};
$('cutInInput').onchange=e=>setCut('in',Number(e.target.value));
$('cutOutInput').onchange=e=>setCut('out',Number(e.target.value));
for(const button of document.querySelectorAll('[data-step]')) button.onclick=()=>{
  const t=current();if(!t)return;
  const [which,delta]=button.dataset.step.split(':');
  setCut(which,(which==='in'?t.cutIn:t.cutOut)+Number(delta));
};
$('markIn').onclick=()=>setCut('in',cursor);
$('markOut').onclick=()=>setCut('out',cursor);
$('detailZoom').oninput=e=>{detailZoom=Number(e.target.value);$('detailZoomValue').textContent=`±${secs(detailZoom)}秒`;drawDetail('in');drawDetail('out');};
for(const button of document.querySelectorAll('[data-target]'))button.onclick=()=>{const value=Number(button.dataset.target);$('targetInput').value=value;applyTarget(value);};
$('applyTarget').onclick=()=>applyTarget($('targetInput').value);
$('targetInput').addEventListener('keydown',e=>{if(e.key==='Enter')applyTarget(e.target.value);});
$('fadeSlider').oninput=e=>{const t=current();if(!t)return;t.fade=Number(e.target.value)/1000;invalidate(t);};
$('fadeShape').onchange=e=>{const t=current();if(!t)return;t.shape=e.target.value;invalidate(t);};
$('applyAll').onclick=()=>{const t=current();if(!t)return;for(const other of tracks){if(other===t)continue;other.fade=t.fade;other.shape=t.shape;invalidate(other,false);}toast(`${tracks.length}曲のクロスフェード設定を揃えました`);};
$('bpmInput').onchange=e=>{const t=current();if(!t)return;t.bpm=clamp(Number(e.target.value)||120,30,300);e.target.value=t.bpm;drawWave();};
$('snapUnit').onchange=e=>{const t=current();if(t){t.snapUnit=Number(e.target.value);drawWave();}};
$('snapEnabled').onchange=e=>{const t=current();if(t){t.snapEnabled=e.target.checked;drawWave();}};
$('formatSelect').onchange=e=>{$('mp3Group').hidden=e.target.value!=='mp3';$('wavGroup').hidden=e.target.value==='mp3';};
$('volumeSlider').oninput=e=>{$('volumeValue').textContent=`${e.target.value}%`;if(monitorGain)monitorGain.gain.value=Number(e.target.value)/100;};
$('playOriginal').onclick=()=>playMode('original',cursor);
$('playShort').onclick=()=>playMode('short');
$('playJoin').onclick=()=>playMode('join');
$('playPause').onclick=togglePause;
$('stopPlay').onclick=()=>{stop();$('playMessage').textContent='停止しました。カット位置を変えて、いつでも試聴し直せます。';drawWave();};
$('seekBar').oninput=e=>seekTo(Number(e.target.value)/1000);
$('exportOne').onclick=()=>exportTracks(false);
$('exportAll').onclick=()=>exportTracks(true);
$('helpButton').onclick=help;
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){$('modalRoot').replaceChildren();if(playback)stop();}
  if(e.code==='Space'&&!e.repeat&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName)&&current()){
    e.preventDefault();if(playback)togglePause();else playMode('short');
  }
});
bindWave();bindDetail('in');bindDetail('out');
if(window.ResizeObserver){const resize=new ResizeObserver(()=>drawAll());for(const el of ['waveCanvas','inDetail','outDetail','seamCanvas'])resize.observe($(el));}
else window.addEventListener('resize',drawAll);
render();
})();
