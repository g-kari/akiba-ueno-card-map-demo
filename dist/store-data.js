"use strict";
const StoreData=(()=>{
  const key="card-map-demo-stores-v1";
  const region=[[139.7652,35.6968],[139.7818,35.7164]];
  const stations=["秋葉原","御徒町","上野"];
  const labels={shop:"カードショップ",play:"対戦スペース",retail:"取扱店"};
  const types=Object.keys(labels);
  const text=(x,field)=>{
    if(typeof x!=="string"||!x.trim()||x.trim().length>80)throw Error(field+"は1〜80文字で入力してください。");
    return x.trim();
  };
  const coord=(x,min,max,field)=>{
    if((typeof x!=="number"&&typeof x!=="string")||String(x).trim()===""||!Number.isFinite(Number(x))||Number(x)<min||Number(x)>max)throw Error(field+"は "+min+"〜"+max+" の範囲で入力してください。");
    return Number(x);
  };
  function validate(raw){
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||typeof raw.id!=="string"||!/^[0-9]{2,4}$/.test(raw.id))throw Error("店舗IDが正しくありません。");
    if(!stations.includes(raw.station))throw Error("最寄り駅を選んでください。");
    if(!types.includes(raw.type))throw Error("店舗タイプを選んでください。");
    return {id:raw.id,name:text(raw.name,"店舗名"),station:raw.station,area:text(raw.area,"エリア"),type:raw.type,
      lat:coord(raw.lat,region[0][1],region[1][1],"緯度"),lon:coord(raw.lon,region[0][0],region[1][0],"経度")};
  }
  function validateRows(list){
    if(!Array.isArray(list)||list.length>250)throw Error("店舗一覧は250件以下の配列にしてください。");
    const clean=list.map(validate);
    if(new Set(clean.map(r=>r.id)).size!==clean.length)throw Error("同じ店舗IDが複数あります。");
    return clean;
  }
  function parse(text){
    const data=JSON.parse(text);
    if(!data||data.version!==1)throw Error("このデモ用のJSONではありません。");
    return validateRows(data.stores);
  }
  function encode(list){return JSON.stringify({version:1,stores:validateRows(list)},null,2);}
  function nextId(rows){const used=new Set(rows.map(r=>r.id));for(let i=1;i<10000;i++){const id=String(i).padStart(2,"0");if(!used.has(id))return id;}throw Error("店舗IDを作れませんでした。");}
  function links(row){
    const xy=row.lat+","+row.lon;
    return {
      place:"https://www.google.com/maps/search/?"+new URLSearchParams({api:"1",query:xy}),
      directions:"https://www.google.com/maps/dir/?"+new URLSearchParams({api:"1",destination:xy,travelmode:"walking"})
    };
  }
  function groups(rows){
    const groups=new Map();
    for(const r of rows){const key=r.lon+","+r.lat;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
    return Array.from(groups.values());
  }
  return {key,region,stations,labels,validate,validateRows,parse,encode,nextId,links,groups};
})();
if(typeof module!=="undefined")module.exports=StoreData;
