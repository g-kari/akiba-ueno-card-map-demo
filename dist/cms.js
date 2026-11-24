"use strict";
(()=>{
  const form=$("#cms-form"),list=$("#cms-list"),status=$("#cms-status"),file=$("#cms-file");
  const editor=$("#editor-title"),remove=$("#cms-delete"),save=$("#cms-save");
  let editing=null,ready=false,savedBeforeEdit=null;
  function message(text){status.textContent=text;}
  function profileSave(next){
    if(!ready)throw Error("店舗初期データを読み込めていません。再読み込みしてください。");
    const clean=StoreData.validateRows(next),encoded=StoreData.encode(clean);
    if(localStorage.getItem(StoreData.key)!==savedBeforeEdit)throw Error("別のタブで更新されました。保存の前に、このページを再読み込みしてください。");
    localStorage.setItem(StoreData.key,encoded);
    savedBeforeEdit=encoded;
    setRows(clean);
    renderList();
  }
  function reset(focus=false){
    editing=null;form.reset();editor.textContent="新しい店舗を追加";save.textContent="追加する";remove.hidden=true;
    if(focus)form.elements.namedItem("name").focus();
  }
  function edit(id){
    const r=rows.find(a=>a.id===id);if(!r)return;
    editing=id;editor.textContent="店舗を編集";
    for(const key of ["name","station","area","type","lat","lon"])form.elements.namedItem(key).value=r[key];
    save.textContent="変更を保存";remove.hidden=false;message("「"+r.name+"」を編集中です。");form.elements.namedItem("name").focus();
  }
  function renderList(){
    list.replaceChildren();$("#cms-count").textContent=rows.length+" 件";
    if(!rows.length){list.append(node("li","店舗がありません。"));return;}
    for(const r of rows){
      const li=node("li",null),block=node("span",null),b=node("button","編集",{type:"button",class:"action","aria-label":r.name+"を編集"});
      block.append(node("strong",r.name),node("small",r.station+" ／ "+labels[r.type]));
      b.addEventListener("click",()=>edit(r.id));li.append(block,b);list.append(li);
    }
  }
  function route(){
    const visible=location.hash==="#manage";
    $("#manage").hidden=!visible;$("#map-view").hidden=visible;
    for(const [link,current] of [[$("#cms-nav"),visible],[$("#map-nav"),!visible]]){
      if(current)link.setAttribute("aria-current","page");else link.removeAttribute("aria-current");
    }
    if(visible){renderList();$("#cms-title").focus({preventScroll:true});}
    else if(ready){loadMap();requestAnimationFrame(()=>{if(map)map.resize();});}
  }
  addEventListener("hashchange",route);route();
  storeReady.then(ok=>{
    ready=ok;renderList();
    if(!ok){message("初期データを読み込めませんでした。再読み込みしてください。");return;}
    try{savedBeforeEdit=localStorage.getItem(StoreData.key);}catch{message("ブラウザーで保存できません。閲覧のみ利用できます。");}
    if(document.documentElement.dataset.storeRecovery)message("保存済みデータを読めなかったため、初期データを表示しています。");
  });
  form.addEventListener("submit",e=>{
    e.preventDefault();
    try{
      const values=Object.fromEntries(new FormData(form));
      const record=StoreData.validate({...values,id:editing??StoreData.nextId(rows)});
      const wasEditing=editing!==null;
      profileSave(wasEditing?rows.map(r=>r.id===editing?record:r):[...rows,record]);
      reset();
      message("「"+record.name+"」を"+(wasEditing?"更新":"追加")+"しました。");
    }catch(err){message("保存できませんでした。"+err.message);}
  });
  $("#cms-new").addEventListener("click",()=>{reset(true);message("");});
  remove.addEventListener("click",()=>{
    const r=rows.find(x=>x.id===editing);if(!r||!confirm("「"+r.name+"」をこのブラウザーの一覧から削除しますか？"))return;
    try{profileSave(rows.filter(x=>x.id!==r.id));reset(true);message("「"+r.name+"」を削除しました。");}
    catch(err){message("削除できませんでした。"+err.message);}
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
      if(!confirm("このブラウザーの"+rows.length+"件を、読み込んだ"+next.length+"件に置き換えますか？"))return;
      profileSave(next);reset();message(next.length+"件を読み込みました。");
    }catch(err){message("読み込めませんでした。"+err.message);}
  });
})();
