"use strict";
// Admin view: store data lives on the server (D1). This script only talks to
// the API. The admin view is gated on a 0g0-id session: without one, the
// login gate is shown instead and no editor is rendered. The API enforces
// the same rule server-side; the gate here is presentation only.
(()=>{
  const form=$("#cms-form"),list=$("#cms-list"),status=$("#cms-status"),file=$("#cms-file");
  const editor=$("#editor-title"),remove=$("#cms-delete"),save=$("#cms-save");
  const gate=$("#login-gate"),authArea=$("#auth-area");
  let editing=null,ready=false,me=null,stats=null;
  // Pin picker: click or drag on the schematic map to set lat/lon, keeping
  // the numeric inputs in sync. Uses the same projection as the public
  // fallback map in app.js (rebuildPins), so the pin lands where the
  // schematic shows it.
  const pinmap=$("#cms-pinmap"),pinEl=$("#cms-pin"),pinDots=$("#cms-pinmap-dots"),pinCoords=$("#cms-pin-coords");
  const stationPoints=StoreData.stationPoints;
  const centerPoint=[(region[0][1]+region[1][1])/2,(region[0][0]+region[1][0])/2];
  function pinXY(lat,lon){return [11+(lon-region[0][0])/(region[1][0]-region[0][0])*78,7+(region[1][1]-lat)/(region[1][1]-region[0][1])*86];}
  function pinLatLon(x,y){return [region[1][1]-(y-7)/86*(region[1][1]-region[0][1]),region[0][0]+(x-11)/78*(region[1][0]-region[0][0])];}
  function placePin(lat,lon,write){
    const la=Math.min(region[1][1],Math.max(region[0][1],lat)),lo=Math.min(region[1][0],Math.max(region[0][0],lon));
    const [x,y]=pinXY(la,lo);pinEl.style.left=x+"%";pinEl.style.top=y+"%";
    pinCoords.textContent="緯度 "+la.toFixed(4)+" ／ 経度 "+lo.toFixed(4);
    if(write){form.elements.namedItem("lat").value=la.toFixed(4);form.elements.namedItem("lon").value=lo.toFixed(4);}
  }
  function syncPinFromInputs(){
    const la=Number(form.elements.namedItem("lat").value),lo=Number(form.elements.namedItem("lon").value);
    if(Number.isFinite(la)&&Number.isFinite(lo)&&la>=region[0][1]&&la<=region[1][1]&&lo>=region[0][0]&&lo<=region[1][0])placePin(la,lo,false);
  }
  function renderPinDots(){
    pinDots.replaceChildren();
    for(const r of rows.slice(0,1000)){const d=node("span",null,{class:"cms-dot",title:r.name});const [x,y]=pinXY(r.lat,r.lon);d.style.left=x+"%";d.style.top=y+"%";pinDots.append(d);}
  }
  let pinDrag=false;
  function pinFromEvent(e){const rect=pinmap.getBoundingClientRect();const [la,lo]=pinLatLon((e.clientX-rect.left)/rect.width*100,(e.clientY-rect.top)/rect.height*100);placePin(la,lo,true);}
  pinmap.addEventListener("pointerdown",e=>{pinDrag=true;pinmap.setPointerCapture(e.pointerId);pinFromEvent(e);});
  pinmap.addEventListener("pointermove",e=>{if(pinDrag)pinFromEvent(e);});
  pinmap.addEventListener("pointerup",()=>{pinDrag=false;});
  pinmap.addEventListener("pointercancel",()=>{pinDrag=false;});
  for(const key of ["lat","lon"])form.elements.namedItem(key).addEventListener("input",syncPinFromInputs);
  form.elements.namedItem("station").addEventListener("change",e=>{const p=stationPoints[e.target.value];if(p)placePin(p[0],p[1],true);});
  placePin(centerPoint[0],centerPoint[1],true);
  const stationSelect=form.elements.namedItem("station");
  for(const st of StoreData.stations)stationSelect.append(node("option",st));
  const pinTags=$("#cms-pinmap-tags");
  for(const [st,[la,lo]] of Object.entries(stationPoints)){const t=node("span",st,{class:"cms-station-tag"});const [x,y]=pinXY(la,lo);t.style.left=x+"%";t.style.top=y+"%";pinTags.append(t);}
  function message(text){status.textContent=text;}
  async function api(path,init){
    const res=await fetch(path,init);
    let body=null;
    try{body=await res.json();}catch{/* empty body */}
    if(!res.ok)throw Error(body&&body.error?body.error:"HTTP "+res.status);
    return body;
  }
  async function refreshStores(){
    // The admin view needs the full dataset (list, edit lookup, export),
    // so it pages through the filtered API instead of one full-table read.
    const all=[];let offset=0,total=Infinity;
    while(offset<total){
      const data=await api("/api/stores?limit=1000&offset="+offset);
      total=data.total;
      all.push(...data.stores);
      offset+=data.stores.length;
      if(!data.stores.length)break;
    }
    const clean=StoreData.validateRows(all);
    setRows(clean);
    renderList();
    return clean;
  }
  function renderAuth(){
    authArea.replaceChildren();
    if(me){
      authArea.append(node("span","アカウント #"+me.accountId,{class:"mast-account"}));
      const b=node("button","ログアウト",{type:"button",class:"mast-auth-button"});
      b.addEventListener("click",async()=>{
        try{await fetch("/auth/logout",{method:"POST"});}catch{/* session is gone either way */}
        me=null;renderAuth();route();
      });
      authArea.append(b);
    }else{
      authArea.append(node("a","ログイン",{href:"/auth/login",class:"mast-auth-button"}));
    }
  }
  function route(){
    const wantsManage=location.hash==="#manage";
    const showManage=wantsManage&&me!==null;
    const showGate=wantsManage&&me===null;
    $("#manage").hidden=!showManage;
    gate.hidden=!showGate;
    $("#map-view").hidden=wantsManage;
    for(const [link,current] of [[$("#cms-nav"),wantsManage],[$("#map-nav"),!wantsManage]]){
      if(current)link.setAttribute("aria-current","page");else link.removeAttribute("aria-current");
    }
    if(showManage){renderList();$("#cms-title").focus({preventScroll:true});}
    else if(showGate){$("#gate-title").focus({preventScroll:true});}
    else if(ready){loadMap();if(typeof syncFromMap==="function")syncFromMap();requestAnimationFrame(()=>{if(map)map.resize();});}
  }
  function reset(focus=false){
    editing=null;form.reset();editor.textContent="新しい店舗を追加";save.textContent="追加する";remove.hidden=true;
    placePin(centerPoint[0],centerPoint[1],true);
  const stationSelect=form.elements.namedItem("station");
  for(const st of StoreData.stations)stationSelect.append(node("option",st));
  const pinTags=$("#cms-pinmap-tags");
  for(const [st,[la,lo]] of Object.entries(stationPoints)){const t=node("span",st,{class:"cms-station-tag"});const [x,y]=pinXY(la,lo);t.style.left=x+"%";t.style.top=y+"%";pinTags.append(t);}
    if(focus)form.elements.namedItem("name").focus();
  }
  function edit(id){
    const r=rows.find(a=>a.id===id);if(!r)return;
    editing=id;editor.textContent="店舗を編集";
    for(const key of ["name","station","area","type","lat","lon"])form.elements.namedItem(key).value=r[key];
    form.elements.namedItem("verified").checked=!!r.verified;
    form.elements.namedItem("source_url").value=r.source_url??"";
    placePin(r.lat,r.lon,false);
    save.textContent="変更を保存";remove.hidden=false;message("「"+r.name+"」を編集中です。");form.elements.namedItem("name").focus();
  }
  function renderList(){
    list.replaceChildren();$("#cms-count").textContent=rows.length+" 件";
    if(!rows.length){list.append(node("li","店舗がありません。"));return;}
    for(const r of rows){
      const li=node("li",null),block=node("span",null),b=node("button","編集",{type:"button",class:"action","aria-label":r.name+"を編集"});
      block.append(node("strong",r.name),node("small",r.station+" ／ "+labels[r.type]+(r.verified?" ／ 実在確認済み":"")));
      const st=stats&&stats.stores[r.id];
      if(st&&(st.view||st.place||st.directions))block.append(node("small","流入: 詳細 "+st.view+" ／ 位置 "+st.place+" ／ ルート "+st.directions));
      b.addEventListener("click",()=>edit(r.id));li.append(block,b);list.append(li);
    }
    renderPinDots();
  }
  addEventListener("hashchange",route);
  (async()=>{
    try{me=await api("/api/me");}catch{me=null;}
    renderAuth();route();
    ready=await storeReady;
    // The public boot only loads the current viewport. When signed in,
    // load the full dataset (paged) so the admin list/edit/export are
    // complete.
    if(me){try{await refreshStores();}catch{/* keep the boot rows */}}
    try{stats=await api("/api/admin/stats");}catch{stats=null;}
    if(stats)$("#cms-stats").textContent="流入計測: 詳細表示 "+stats.totals.view+" ／ 位置リンク "+stats.totals.place+" ／ ルートリンク "+stats.totals.directions;
    renderList();
    if(!ready)message("店舗データを読み込めませんでした。再読み込みしてください。");
  })();
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    if(!ready){message("店舗データを読み込めていません。再読み込みしてください。");return;}
    try{
      const values=Object.fromEntries(new FormData(form));
      const payload={name:values.name,station:values.station,area:values.area,type:values.type,lat:values.lat,lon:values.lon,verified:form.elements.namedItem("verified").checked,source_url:values.source_url?values.source_url:null};
      StoreData.validate({...payload,id:editing??"99"});
      const wasEditing=editing!==null;
      const init={headers:{"content-type":"application/json"},body:JSON.stringify(payload)};
      if(wasEditing)await api("/api/admin/stores/"+editing,{...init,method:"PUT"});
      else await api("/api/admin/stores",{...init,method:"POST"});
      await refreshStores();
      reset();
      message("「"+payload.name.trim()+"」を"+(wasEditing?"更新":"追加")+"しました。");
    }catch(err){message("保存できませんでした。"+err.message);}
  });
  $("#cms-new").addEventListener("click",()=>{reset(true);message("");});
  remove.addEventListener("click",async()=>{
    const r=rows.find(x=>x.id===editing);if(!r||!confirm("「"+r.name+"」をサーバーの一覧から削除しますか？"))return;
    try{
      await api("/api/admin/stores/"+r.id,{method:"DELETE"});
      await refreshStores();reset(true);message("「"+r.name+"」を削除しました。");
    }catch(err){message("削除できませんでした。"+err.message);}
  });
  $("#cms-export").addEventListener("click",()=>{
    if(!ready){message("先に店舗データを読み込んでください。");return;}
    const url=URL.createObjectURL(new Blob([StoreData.encode(rows)],{type:"application/json"}));
    const a=node("a",null,{href:url,download:"card-map-stores.json"});
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    message(rows.length+"件のデータを保存しました。");
  });
  $("#cms-import").addEventListener("click",()=>file.click());
  file.addEventListener("change",async()=>{
    const input=file.files[0];file.value="";if(!input)return;
    try{
      if(input.size>250000)throw Error("250 KB以下のJSONにしてください。");
      const next=StoreData.parse(await input.text());
      if(!confirm("サーバーの"+rows.length+"件を、読み込んだ"+next.length+"件に置き換えますか？"))return;
      await api("/api/admin/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({stores:next})});
      await refreshStores();reset();message(next.length+"件を読み込みました。");
    }catch(err){message("読み込めませんでした。"+err.message);}
  });
})();
