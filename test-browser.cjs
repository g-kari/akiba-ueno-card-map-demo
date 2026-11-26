"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {chromium}=require("playwright");
const url="http://cardmap.qa.test/";
const files={"html":"text/html","css":"text/css","js":"application/javascript","json":"application/json","csv":"text/csv"};
(async()=>{
const b=await chromium.launch({executablePath:"/usr/bin/chromium",headless:true,args:["--disable-dev-shm-usage","--disable-crash-reporter"]});
try{
for(const width of [1440,390]){
 const page=await b.newPage({viewport:{width,height:900},isMobile:width===390,deviceScaleFactor:1,acceptDownloads:true});
 const errs=[];page.on("pageerror",e=>errs.push(e.message));page.on("dialog",d=>d.accept());
 // Deterministic local frontend test, not an assertion about remote map assets.
 await page.route("**/*",async route=>{
  const uri=new URL(route.request().url());
  if(uri.hostname!=="cardmap.qa.test")return route.abort();
  const filename=uri.pathname==="/"?"index.html":path.basename(uri.pathname);
  const file=path.join(__dirname,"dist",filename);
  if(!fs.existsSync(file))return route.fulfill({status:404,body:"not found"});
  await route.fulfill({status:200,contentType:files[filename.split(".").pop()],body:fs.readFileSync(file)});
 });
 await page.goto(url);
 await page.waitForFunction(()=>document.querySelector("#count").textContent==="11000 件");
 await page.screenshot({path:"/tmp/cardmap-qa-"+width+".png",fullPage:true});
 await page.locator("#q").fill("Okachimachi");
 assert.equal(await page.locator("#count").textContent(),"3 件");
 await page.getByText("店名",{exact:true}).click();
 await page.locator("#q").fill("デッキ工房");
 assert.equal(await page.locator("#count").textContent(),"1 件");
 await page.locator("#list button").click();
 assert.equal(new URL(await page.getByRole("link",{name:"Google マップで位置を見る"}).getAttribute("href")).searchParams.get("query"),"35.7107,139.7787");
 assert.equal(new URL(await page.getByRole("link",{name:"徒歩ルートの例"}).getAttribute("href")).searchParams.get("travelmode"),"walking");
 await page.locator("#toolbar-reset").click();
 assert.equal(await page.locator("#count").textContent(),"11000 件");
 assert.ok(await page.locator("#toolbar-reset").isVisible());
 await page.locator("#cms-nav").click();
 await page.getByLabel("店舗名",{exact:true}).fill("動作確認デモ店舗");
 await page.getByLabel("最寄り駅",{exact:true}).selectOption("秋葉原");
 await page.getByLabel("エリア",{exact:true}).fill("外神田");
 await page.getByLabel("店舗タイプ",{exact:true}).selectOption("play");
 await page.getByLabel("緯度",{exact:true}).fill("35.7002");
 await page.getByLabel("経度",{exact:true}).fill("139.7708");
 await page.locator("#cms-save").click();
 assert.equal(await page.locator("#cms-count").textContent(),"11001 件");
 await page.reload();
 await page.waitForFunction(()=>document.querySelector("#cms-count").textContent==="11001 件");
 await page.screenshot({path:"/tmp/cardmap-cms-qa-"+width+".png",fullPage:true});
 await page.getByRole("button",{name:"動作確認デモ店舗を編集"}).click();
 await page.getByLabel("店舗名",{exact:true}).fill("確認済みデモ店舗");
 await page.locator("#cms-save").click();
 assert.equal(await page.getByRole("button",{name:"確認済みデモ店舗を編集"}).count(),1);
 const dl=page.waitForEvent("download");
 await page.locator("#cms-export").click();
 const download=await dl;
 assert.equal(download.suggestedFilename(),"card-map-stores.json");
 const backup=fs.readFileSync(await download.path());
 assert.equal(JSON.parse(backup).stores.length,10);
 await page.locator("#map-nav").click();
 await page.getByRole("button",{name:"同じ位置の店舗2件"}).click();
 await page.getByRole("button",{name:"確認済みデモ店舗",exact:true}).click();
 assert.ok((await page.locator("#detail").textContent()).includes("確認済みデモ店舗"));
 await page.locator("#cms-nav").click();
 await page.getByRole("button",{name:"確認済みデモ店舗を編集"}).click();
 await page.locator("#cms-delete").click();
 await page.waitForFunction(()=>document.querySelector("#cms-count").textContent==="11000 件");
 await page.locator("#cms-file").setInputFiles({name:"backup.json",mimeType:"application/json",buffer:backup});
 await page.waitForFunction(()=>document.querySelector("#cms-count").textContent==="11001 件");
 await page.locator("#cms-file").setInputFiles({name:"bad.json",mimeType:"application/json",buffer:Buffer.from('{"version":2,"stores":[]}')});
 await page.waitForFunction(()=>document.querySelector("#cms-status").textContent.includes("読み込めませんでした"));
 assert.equal(await page.locator("#cms-count").textContent(),"11001 件");
 for(const route of ["#manage","#map-view"]){
  await page.goto(url+route);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 assert.deepEqual(errs,[]);
 await page.close();
 console.log(width+" px: search, Google URLs, CRUD, storage, backup round trip, validation, duplicate pins, overflow passed");
}
} finally{await b.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
