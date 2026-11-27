"use strict";
const $=s=>document.querySelector(s);
const els={q:$("#q"),list:$("#list"),count:$("#count"),empty:$("#empty"),detail:$("#detail"),box:$("#mapbox"),tiles:$("#tiles"),fallback:$("#fallback-pins"),source:$("#source")};
const stationBox=document.querySelector(".stations");
for(const st of StoreData.stations){const b=document.createElement("button");b.type="button";b.dataset.station=st;b.setAttribute("aria-pressed","false");b.textContent=st;stationBox.append(b);}
const stations=[...stationBox.querySelectorAll("[data-station]")];
const radios=[...document.querySelectorAll('input[name="type"]')];
const {labels,region}=StoreData;
const modes=[...document.querySelectorAll('input[name="mode"]')];
const reduced=matchMedia("(prefers-reduced-motion: reduce)");
const state={type:"all",mode:"place",query:"",selected:null};
let rows=[],filtered=[],map=null,mapReady=false,markers=[],buttons=[];
// Viewport-driven loading: `rows` only ever holds the stores for the
// current map view (or the focused station). `serverTotal` is the number
// of stores inside the current view before the page cap, so a truncated
// view can say so instead of silently dropping stores.
let serverTotal=null,viewSeq=0,activeStation=null,programmaticMove=false,moveHooked=false;
const normalize=s=>s.normalize("NFKC").toLocaleLowerCase("ja").replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96)).replace(/[\s・･　]+/g,"");
const aliases={"秋葉原":"アキバ 秋葉原駅 あきはばら Akihabara","御徒町":"おかちまち 御徒町駅 Okachimachi","上野":"うえの 上野駅 Ueno"};
function node(tag,content,props={}){const n=document.createElement(tag);if(content!==null)n.textContent=content;for(const [key,value] of Object.entries(props))n.setAttribute(key,value);return n}
function setHash(){if(location.hash==="#manage")return;const url=new URL(location.href);url.hash=state.selected?"shop="+state.selected:"";history.replaceState(null,"",url.pathname+url.search+url.hash)}
function rowButton(r){const b=node("button",null,{class:"row",type:"button","data-id":r.id,"data-type":r.type,"aria-pressed":"false"});const info=node("span",null);info.append(node("strong",r.name),node("small",r.station+"エリア ／ "+labels[r.type]+(r.verified?" ／ 実在確認済み":"")));b.append(node("span",r.id,{class:"badge","aria-hidden":"true"}),info);b.addEventListener("click",()=>select(r.id,true));return b}
function pin(group,fallback){
  const r=group[0], multiple=group.length>1;
  const b=node("button",null,{type:"button",class:"pin"+(fallback?" compact":""),"data-id":r.id,"data-type":multiple?"group":r.type,"aria-label":multiple?"同じ位置の店舗"+group.length+"件":r.id+" "+r.name,"aria-pressed":"false"});
  b.groupIds=group.map(x=>x.id);
  b.append(node("i",multiple?String(group.length):r.id,{"aria-hidden":"true"}));
  if(multiple)b.setAttribute("aria-controls","pin-group");
  b.addEventListener("click",e=>{e.stopPropagation();if(multiple)showPinGroup(group);else select(r.id,false)});
  return b;
}
function showPinGroup(group){
  const panel=$("#pin-group");
  panel.replaceChildren(node("strong","同じ位置に "+group.length+" 件"));
  for(const r of group){
    const b=node("button",r.name,{type:"button",class:"action"});
    b.addEventListener("click",()=>{select(r.id,false);buttons.find(x=>x.dataset.id===r.id)?.focus({preventScroll:true})});
    panel.append(b);
  }
  panel.hidden=false;
  panel.querySelector("button").focus({preventScroll:true});
}
function sendEvent(kind,id){try{fetch("/api/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({store_id:id,kind}),keepalive:true}).catch(()=>{});}catch{}}
function setSearchMode(mode){
  state.mode=mode;
  modes.forEach(e=>{e.checked=e.value===mode});
  $("#q-label").textContent=mode==="name"?"店名を入力":"地名・駅名を入力";
  els.q.placeholder=mode==="name"?"例：デッキ工房":"例：秋葉原、御徒町";
}
function refresh(){
  const tokens=state.query.trim().split(/\s+/).map(normalize).filter(Boolean);
  filtered=rows.filter(r=>(state.type==="all"||r.type===state.type)&&tokens.every(k=>normalize(state.mode==="name"?r.name:r.area+" "+r.station+" "+(aliases[r.station]??"")).includes(k)));
  if(!filtered.some(r=>r.id===state.selected))state.selected=null;
  $("#pin-group").hidden=true;
  setHash();els.count.textContent=filtered.length+" 件"+(serverTotal!==null&&serverTotal>rows.length?"（この範囲は全"+serverTotal+"件中 "+rows.length+" 件まで表示中。拡大すると絞り込めます）":"");els.empty.hidden=filtered.length!==0;
  els.list.replaceChildren();buttons=filtered.map(r=>{const item=node("li",null),b=rowButton(r);item.append(b);els.list.append(item);return b});
  rebuildPins();updateSelection();
  stations.forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.station===activeStation||(state.mode==="place"&&state.query!==""&&normalize(b.dataset.station)===normalize(state.query)))));
}
function rebuildPins(){
  els.fallback.replaceChildren();markers.forEach(m=>m.remove());markers=[];
  for(const group of StoreData.groups(filtered)){
    const r=group[0],p=pin(group,true);
    p.style.left=(11+(r.lon-region[0][0])/(region[1][0]-region[0][0])*78)+"%";
    p.style.top=(7+(region[1][1]-r.lat)/(region[1][1]-region[0][1])*86)+"%";
    els.fallback.append(p);
    if(mapReady){const el=pin(group,false);markers.push(new maplibregl.Marker({element:el,anchor:"center"}).setLngLat([r.lon,r.lat]).addTo(map))}
  }
}
function updateSelection(){
  for(const b of [...buttons,...els.fallback.children,...markers.map(m=>m.getElement())])b.setAttribute("aria-pressed",String(b.groupIds?b.groupIds.includes(state.selected):b.dataset.id===state.selected));
  const r=filtered.find(t=>t.id===state.selected);
  if(r){
    const urls=StoreData.links(r);
    const actions=node("div",null,{class:"detail-actions"});
    const placeLink=node("a","Google マップで位置を見る",{href:urls.place,target:"_blank",rel:"noopener noreferrer"});
    const dirLink=node("a","徒歩ルートの例",{href:urls.directions,target:"_blank",rel:"noopener noreferrer"});
    placeLink.addEventListener("click",()=>sendEvent("place",r.id));
    dirLink.addEventListener("click",()=>sendEvent("directions",r.id));
    actions.append(placeLink,dirLink);
    els.detail.replaceChildren(node("strong",r.id+"  "+r.name),node("span",r.station+"エリア ／ "+r.area+" ／ "+labels[r.type]),actions,node("small","架空店舗です。リンク先はデモ座標で、実店舗への案内ではありません。"));
    if(r.verified){
      const proof=node("small","実在確認済み"+(r.verified_at?"（"+String(r.verified_at).slice(0,10)+"）":""));
      if(r.source_url)proof.append(" ",node("a","出典",{href:r.source_url,target:"_blank",rel:"noopener noreferrer"}));
      els.detail.append(proof);
    }
  }else els.detail.replaceChildren(node("strong","店舗を選択"),node("span","一覧または地図のピンから店舗を選べます。"));
}
// Fetches one filtered page from the API and validates only what came
// back. The response also carries the pre-cap total for the filter.
async function fetchStores(params){
  const res=await fetch("/api/stores?"+new URLSearchParams(params));
  if(!res.ok)throw Error("data");
  const data=await res.json();
  return {rows:StoreData.validateRows(data.stores),total:data.total};
}
function applyFetch(result){rows=result.rows;serverTotal=result.total;refresh();}
// Reloads the stores for the map's current viewport. Called whenever the
// map settles after a pan/zoom, so the list and pins always match what is
// on screen (the "search this area" behaviour, applied automatically).
async function syncFromMap(){
  if(!mapReady||!map)return;
  const b=map.getBounds(),seq=++viewSeq;
  // The viewport can extend past the data region (zoomed out, wide
  // screens); clamp it to the region the API accepts.
  const bbox=[Math.max(region[0][0],b.getWest()),Math.max(region[0][1],b.getSouth()),Math.min(region[1][0],b.getEast()),Math.min(region[1][1],b.getNorth())];
  if(bbox[0]>=bbox[2]||bbox[1]>=bbox[3]){applyFetch({rows:[],total:0});return;}
  try{
    const result=await fetchStores({bbox:bbox.join(","),limit:"1000"});
    if(seq!==viewSeq)return;
    applyFetch(result);
  }catch{/* keep the current rows when a viewport fetch fails */}
}
let moveTimer=null;
function onMoveEnd(){
  const wasProgrammatic=programmaticMove;programmaticMove=false;
  if(!wasProgrammatic)activeStation=null;
  clearTimeout(moveTimer);moveTimer=setTimeout(syncFromMap,200);
}
function select(id,center){$("#pin-group").hidden=true;state.selected=id;sendEvent("view",id);setHash();updateSelection();if(center&&mapReady){const r=filtered.find(t=>t.id===id);if(r){programmaticMove=true;map.easeTo({center:[r.lon,r.lat],duration:reduced.matches?0:380})}}
if(!center&&els.list.scrollHeight>els.list.clientHeight){const row=buttons.find(b=>b.dataset.id===id);if(row){const parent=els.list.getBoundingClientRect(),child=row.getBoundingClientRect();if(child.top<parent.top||child.bottom>parent.bottom)els.list.scrollTop+=child.top-parent.top}}
}
function clear(){state.query="";state.type="all";state.selected=null;els.q.value="";radios[0].checked=true;setSearchMode("place");if(activeStation){activeStation=null;if(mapReady&&map){programmaticMove=true;map.fitBounds(region,{padding:48,duration:reduced.matches?0:380});}else boot();}refresh();els.q.focus()}
$("#search").addEventListener("submit",e=>{
  e.preventDefault();state.query=els.q.value;refresh();
});
els.q.addEventListener("input",e=>{if(!e.isComposing){state.query=e.target.value;refresh()}});
els.q.addEventListener("compositionend",e=>{state.query=e.target.value;refresh()});
radios.forEach(b=>b.addEventListener("change",()=>{state.type=b.value;refresh()}));
modes.forEach(b=>b.addEventListener("change",()=>{setSearchMode(b.value);refresh()}));
stations.forEach(b=>b.addEventListener("click",()=>{
  const st=b.dataset.station;
  setSearchMode("place");state.query="";els.q.value="";
  if(activeStation===st){
    // Clicking the focused station again returns to the whole-region view.
    activeStation=null;refresh();
    if(mapReady&&map){programmaticMove=true;map.fitBounds(region,{padding:48,duration:reduced.matches?0:380});}
    else boot();
    return;
  }
  activeStation=st;
  const p=StoreData.stationPoints[st];
  if(mapReady&&map&&p){
    // Move the map to the station; the moveend handler then reloads the
    // stores for the new viewport, so the station shows up via bbox.
    refresh();
    programmaticMove=true;
    map.fitBounds([[p[1]-0.075,p[0]-0.06],[p[1]+0.075,p[0]+0.06]],{padding:40,duration:reduced.matches?0:380});
  }else{
    // Schematic fallback (no live map to move): fetch this station only.
    refresh();
    const seq=++viewSeq;
    fetchStores({station:st,limit:"1000"}).then(result=>{if(seq===viewSeq&&activeStation===st)applyFetch(result);}).catch(()=>{});
  }
}));
$("#reset").addEventListener("click",clear);
$("#toolbar-reset").addEventListener("click",clear);
addEventListener("hashchange",async()=>{if(location.hash==="#manage")return;if(!$("#map-view").hidden&&map)map.resize();const hid=new URLSearchParams(location.hash.slice(1)).get("shop");state.selected=hid&&rows.some(r=>r.id===hid)?hid:null;if(hid&&!state.selected){try{const one=await fetchStores({id:hid});if(one.rows.length){rows=[...rows,...one.rows];state.selected=hid;state.query="";state.type="all";els.q.value="";radios[0].checked=true;refresh();return;}}catch{/* keep the current view */}}if(state.selected&&!filtered.some(x=>x.id===state.selected)){state.query="";state.type="all";els.q.value="";radios[0].checked=true;refresh()}else updateSelection()});
function liveMap(){try{
if(!window.maplibregl)return;
map=new maplibregl.Map({container:els.tiles,style:{version:8,sources:{gsi:{type:"raster",tiles:["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],tileSize:256,minzoom:5,maxzoom:18}},layers:[{id:"gsi",type:"raster",source:"gsi"}]},bounds:region,fitBoundsOptions:{padding:48},minZoom:3,maxZoom:18,attributionControl:false,dragRotate:false,pitchWithRotate:false,scrollZoom:false});
map.touchZoomRotate.disableRotation();map.addControl(new maplibregl.NavigationControl({showCompass:false}),"top-right");
function reveal(){if(mapReady)return;mapReady=true;els.tiles.removeAttribute("aria-hidden");els.box.classList.add("live");els.source.replaceChildren("出典：",node("a","国土地理院タイル",{href:"https://maps.gsi.go.jp/development/ichiran.html",target:"_blank",rel:"noopener noreferrer"})," ／ 地図ライブラリ: MapLibre GL JS ／ 店舗は架空のサンプルです");rebuildPins();updateSelection();if(!moveHooked){moveHooked=true;map.on("moveend",onMoveEnd);}syncFromMap()}
let probeOk=false, settled=false;
const probe=new Image(), [lon,lat]=[139.774,35.707], z=14, n=2**z, rad=lat*Math.PI/180;
const tx=Math.floor((lon+180)/360*n),ty=Math.floor((1-Math.asinh(Math.tan(rad))/Math.PI)/2*n);
probe.onload=()=>{probeOk=true;if(settled&&map.isSourceLoaded("gsi"))reveal()};
probe.src="https://cyberjapandata.gsi.go.jp/xyz/pale/"+z+"/"+tx+"/"+ty+".png";
map.on("idle",()=>{settled=true;if(probeOk&&map.isSourceLoaded("gsi"))reveal()});
map.on("sourcedata",e=>{if(e.sourceId==="gsi"&&e.tile?.state==="loaded")reveal()});
}catch{/* Use the local schematic when WebGL is unavailable. */}}
let mapRequested=false;
function loadMap(){if(mapRequested)return;mapRequested=true;const css=node("link",null,{rel:"stylesheet",href:"https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css"});document.head.append(css);const js=node("script",null,{src:"https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js"});js.onload=()=>{if(css.sheet)liveMap();else css.onload=liveMap};document.head.append(js)}
function setRows(next){rows=next;refresh();}
async function boot(){
  try{
    // Initial view = the map's initial viewport (the whole region). Only
    // one capped page is fetched, never the whole table; the response
    // total drives the "zoom in to narrow down" notice.
    const first=await fetchStores({bbox:[region[0][0],region[0][1],region[1][0],region[1][1]].join(","),limit:"1000"});
    rows=first.rows;serverTotal=first.total;
    const hid=location.hash.startsWith("#shop=")?new URLSearchParams(location.hash.slice(1)).get("shop"):null;
    if(hid&&!rows.some(r=>r.id===hid)){
      try{const one=await fetchStores({id:hid});if(one.rows.length)rows=[...rows,...one.rows];}catch{/* deep link is best-effort */}
    }
    state.selected=hid&&rows.some(r=>r.id===hid)?hid:null;
    refresh();
    if(location.hash!=="#manage")loadMap();
    return true;
  }catch{
    els.count.textContent="読み込めませんでした";
    els.detail.replaceChildren(node("strong","店舗データを読み込めませんでした"),node("span","ページを再読み込みしてください。"));
    return false;
  }
}
const storeReady=boot();
